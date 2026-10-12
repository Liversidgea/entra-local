/**
 * SCIM interop suite (spec `2026-10-12_scim-outbound-provisioning`, "Interop test environment").
 *
 * Two Entra Local instances (Contoso = A, Fabrikam = B) provision different, partly overlapping
 * directories into ONE shared Keycloak realm via Keycloak's native SCIM Realm API. Runs inside the
 * `runner` container of `docker-compose.yml` with plain `node --test` (Node type stripping): no npm
 * dependencies and no relative imports, so the runner needs nothing installed.
 *
 * Steps run sequentially and build on each other; each asserts Keycloak state through Keycloak's
 * own SCIM API plus each instance's provisioning summary/logs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

const ENTRA_A = process.env.ENTRA_A_URL ?? 'https://localhost:18443';
const ENTRA_B = process.env.ENTRA_B_URL ?? 'https://localhost:28443';
const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:18080';
const REALM = 'shared';
const SCIM_BASE = `${KEYCLOAK}/realms/${REALM}/scim/v2`;
const CLIENT_ID = 'entra-provisioning';
const CLIENT_SECRET = 'entra-provisioning-secret';

type Json = Record<string, any>;

interface FixtureUser {
  userPrincipalName: string;
  displayName: string;
  givenName?: string;
  surname?: string;
  accountEnabled?: boolean;
}
interface Fixture {
  name: string;
  users: FixtureUser[];
  groups: { displayName: string; members: string[] }[];
}

interface Instance {
  label: 'A' | 'B';
  base: string;
  fixture: Fixture;
  appId: string;
  /** UPN → emulator user id. */
  userIds: Map<string, string>;
  /** displayName → emulator group id. */
  groupIds: Map<string, string>;
}

const loadFixture = (file: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')) as Fixture;

const A: Instance = {
  label: 'A',
  base: ENTRA_A,
  fixture: loadFixture('tenant-a.json'),
  appId: '',
  userIds: new Map(),
  groupIds: new Map(),
};
const B: Instance = {
  label: 'B',
  base: ENTRA_B,
  fixture: loadFixture('tenant-b.json'),
  appId: '',
  userIds: new Map(),
  groupIds: new Map(),
};

let token = '';

// --- HTTP helpers -------------------------------------------------------------------------------

async function admin(inst: Instance, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${inst.base}/admin/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${inst.label} ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as Json) : {};
}

async function fetchToken(): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const body = (await res.json()) as Json;
  assert.equal(res.status, 200, `Keycloak token request failed: ${JSON.stringify(body)}`);
  return body.access_token as string;
}

async function kc(path: string): Promise<Json> {
  const res = await fetch(`${SCIM_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/scim+json' },
  });
  assert.equal(res.status, 200, `Keycloak GET ${path} → ${res.status}`);
  return (await res.json()) as Json;
}

/** All (non service-account) SCIM users in the shared realm, keyed by lowercase userName. */
async function kcUsers(): Promise<Map<string, Json>> {
  const list = await kc('/Users?count=500');
  const users = new Map<string, Json>();
  for (const u of (list.Resources ?? []) as Json[]) {
    const name = String(u.userName).toLowerCase();
    if (!name.startsWith('service-account-')) users.set(name, u);
  }
  return users;
}

async function kcGroups(): Promise<Map<string, Json>> {
  const list = await kc('/Groups?count=500');
  const groups = new Map<string, Json>();
  for (const g of (list.Resources ?? []) as Json[]) groups.set(String(g.displayName), g);
  return groups;
}

/** Member userNames of a Keycloak group (resolved through the user list). */
async function kcMembers(displayName: string): Promise<string[]> {
  const group = (await kcGroups()).get(displayName);
  assert.ok(group, `Keycloak group '${displayName}' missing`);
  // Keycloak only returns `members` when explicitly requested.
  const full = await kc(`/Groups/${group.id}?attributes=members`);
  const byId = new Map([...(await kcUsers()).values()].map((u) => [u.id as string, u]));
  return ((full.members ?? []) as Json[])
    .map((m) => String(byId.get(m.value as string)?.userName ?? m.value).toLowerCase())
    .sort();
}

/** Run a job; on a non-success outcome, attach its failure log entries for diagnostics. */
async function job(inst: Instance, kind: 'cycles' | 'restart'): Promise<Json> {
  const summary = await admin(inst, 'POST', `/apps/${inst.appId}/provisioning/${kind}`);
  if (summary.outcome !== 'success') {
    const page = await admin(
      inst,
      'GET',
      `/apps/${inst.appId}/provisioning/logs?top=50&outcome=failure&cycleId=${summary.id}`,
    );
    summary.failures = (page.value as Json[]).map(
      (l) => `${l.method} ${l.url} → ${l.statusCode}: ${l.errorMessage} | req=${l.requestBody} | res=${l.responseBody}`,
    );
  }
  return summary;
}

const cycle = (inst: Instance) => job(inst, 'cycles');

async function logs(inst: Instance, cycleId: string): Promise<Json[]> {
  const page = await admin(
    inst,
    'GET',
    `/apps/${inst.appId}/provisioning/logs?top=200&cycleId=${cycleId}`,
  );
  return page.value as Json[];
}

function assertCycle(summary: Json, outcome = 'success'): void {
  assert.equal(
    summary.outcome,
    outcome,
    [
      `cycle outcome ${summary.outcome}: ${JSON.stringify(summary.counts)}`,
      ...((summary.failures as string[] | undefined) ?? []),
    ].join('\n'),
  );
}

// --- Setup --------------------------------------------------------------------------------------

async function seedInstance(inst: Instance): Promise<void> {
  // Wipe the default demo directory (keeps the tenant row + signing key).
  await admin(inst, 'POST', '/reset', { reseed: false });
  for (const user of inst.fixture.users) {
    const created = await admin(inst, 'POST', '/users', {
      ...user,
      mail: user.userPrincipalName,
      accountEnabled: user.accountEnabled ?? true,
    });
    inst.userIds.set(user.userPrincipalName, created.id as string);
  }
  for (const group of inst.fixture.groups) {
    const created = await admin(inst, 'POST', '/groups', { displayName: group.displayName });
    inst.groupIds.set(group.displayName, created.id as string);
    for (const upn of group.members) {
      await admin(inst, 'POST', `/groups/${created.id}/members`, {
        userId: inst.userIds.get(upn),
      });
    }
  }
  const app = await admin(inst, 'POST', '/apps', { displayName: 'Keycloak SCIM (shared)' });
  inst.appId = app.id as string;
  await admin(inst, 'PUT', `/apps/${inst.appId}/provisioning`, {
    enabled: true,
    tenantUrl: SCIM_BASE,
    secretToken: token,
    scope: { type: 'all' },
    autoSync: false,
    patchDialect: 'compliant',
  });
}

before(async () => {
  token = await fetchToken();
  await seedInstance(A);
  await seedInstance(B);
});

after(() => {
  // Nothing to clean up: `docker compose down -v` discards all state.
});

// --- Scenario -----------------------------------------------------------------------------------

test('1. test connection succeeds on both instances', async () => {
  for (const inst of [A, B]) {
    const res = await admin(inst, 'POST', `/apps/${inst.appId}/provisioning/test-connection`);
    assert.equal(res.ok, true, `${inst.label}: ${res.message}`);
  }
});

test('2. cycle A creates Contoso users and groups, skipping the disabled user', async () => {
  const summary = await cycle(A);
  assertCycle(summary);
  const users = await kcUsers();
  assert.deepEqual(
    [...users.keys()].sort(),
    [
      'alex.smith@contoso.test',
      'jordan.lee@contoso.test',
      'pat.morgan@partner.test',
      'robin.chen@partner.test',
      'taylor.brooks@contoso.test',
    ],
  );
  assert.equal(users.has('sam.patel@contoso.test'), false);
  const skip = (await logs(A, summary.id)).find((l) => l.action === 'skip');
  assert.equal(skip?.errorMessage, 'disabled_not_created');

  assert.deepEqual([...(await kcGroups()).keys()].sort(), ['Contoso Sales', 'Engineering']);
  assert.deepEqual(await kcMembers('Engineering'), [
    'alex.smith@contoso.test',
    'jordan.lee@contoso.test',
    'pat.morgan@partner.test',
  ]);
  assert.deepEqual(await kcMembers('Contoso Sales'), [
    'robin.chen@partner.test',
    'taylor.brooks@contoso.test',
  ]);
});

test('3. cycle B adopts overlapping users and Engineering instead of duplicating', async () => {
  const summary = await cycle(B);
  assertCycle(summary);
  const entries = await logs(B, summary.id);
  for (const upn of ['pat.morgan@partner.test', 'robin.chen@partner.test']) {
    const sourceId = B.userIds.get(upn);
    const mine = entries.filter((l) => l.sourceId === sourceId);
    assert.ok(
      mine.some((l) => l.action === 'query' && JSON.parse(l.responseBody).totalResults === 1),
      `${upn}: expected a matching query with one result`,
    );
    assert.equal(
      mine.some((l) => l.action === 'create'),
      false,
      `${upn}: must be adopted, not POSTed`,
    );
  }
  const engId = B.groupIds.get('Engineering');
  assert.equal(
    entries.some((l) => l.sourceId === engId && l.action === 'create'),
    false,
    'Engineering must be adopted by displayName',
  );

  const users = await kcUsers();
  assert.equal(users.size, 8);
  assert.deepEqual([...(await kcGroups()).keys()].sort(), [
    'Contoso Sales',
    'Engineering',
    'Fabrikam Ops',
  ]);
  assert.deepEqual(await kcMembers('Engineering'), [
    'alex.smith@contoso.test',
    'alex.smith@fabrikam.test',
    'casey.ng@fabrikam.test',
    'jordan.lee@contoso.test',
    'pat.morgan@partner.test',
  ]);
  assert.deepEqual(await kcMembers('Fabrikam Ops'), [
    'jordan.lee@fabrikam.test',
    'robin.chen@partner.test',
  ]);
});

test('4. same local part on different domains stays two distinct users', async () => {
  const users = await kcUsers();
  for (const local of ['alex.smith', 'jordan.lee']) {
    const contoso = users.get(`${local}@contoso.test`);
    const fabrikam = users.get(`${local}@fabrikam.test`);
    assert.ok(contoso && fabrikam, `${local}: both users must exist`);
    assert.notEqual(contoso.id, fabrikam.id);
    assert.notEqual(contoso.emails?.[0]?.value, fabrikam.emails?.[0]?.value);
  }
  for (const inst of [A, B]) {
    const page = await admin(
      inst,
      'GET',
      `/apps/${inst.appId}/provisioning/logs?top=200&outcome=failure`,
    );
    assert.equal(page.count, 0, `${inst.label} logged failures: ${JSON.stringify(page.value)}`);
  }
});

test('5. conflicting overlap: last writer wins, and A does not fight back', async () => {
  // Keycloak 26.8 doesn't store a user's SCIM displayName, so assert what B sent instead: on
  // adopting robin.chen it PATCHed its own (different) displayName.
  const page = await admin(B, 'GET', `/apps/${B.appId}/provisioning/logs?top=200`);
  const robinId = B.userIds.get('robin.chen@partner.test');
  const patch = (page.value as Json[]).find(
    (l) => l.sourceId === robinId && l.method === 'PATCH' && l.outcome === 'success',
  );
  assert.ok(patch, 'B should PATCH the adopted robin.chen');
  assert.deepEqual(JSON.parse(patch.requestBody).Operations, [
    { op: 'replace', path: 'displayName', value: 'Robin Chen (Fabrikam)' },
  ]);
  const summary = await cycle(A);
  assertCycle(summary);
  const writes = (await logs(A, summary.id)).filter((l) => l.method !== 'GET');
  assert.equal(writes.length, 0, 'A diffs against its own last-synced state');
});

test('6. re-running both cycles sends no writes', async () => {
  for (const inst of [A, B]) {
    const summary = await cycle(inst);
    assertCycle(summary);
    const writes = (await logs(inst, summary.id)).filter((l) => l.method !== 'GET');
    assert.equal(
      writes.length,
      0,
      `${inst.label} sent writes on a no-change cycle: ${JSON.stringify(writes)}`,
    );
  }
});

test('7. disabling alex.smith in A only disables the Contoso user', async () => {
  await admin(A, 'PATCH', `/users/${A.userIds.get('alex.smith@contoso.test')}`, {
    accountEnabled: false,
  });
  const summary = await cycle(A);
  assertCycle(summary);
  assert.equal(summary.counts.disabled, 1);
  const users = await kcUsers();
  assert.equal(users.get('alex.smith@contoso.test')?.active, false);
  assert.equal(users.get('alex.smith@fabrikam.test')?.active, true);
});

test('8. removing pat.morgan from A’s Engineering affects the shared group; B stays quiet', async () => {
  await admin(
    A,
    'DELETE',
    `/groups/${A.groupIds.get('Engineering')}/members/${A.userIds.get('pat.morgan@partner.test')}`,
  );
  const summary = await cycle(A);
  assertCycle(summary);
  assert.equal((await kcMembers('Engineering')).includes('pat.morgan@partner.test'), false);

  const bSummary = await cycle(B);
  const bWrites = (await logs(B, bSummary.id)).filter((l) => l.method !== 'GET');
  assert.equal(bWrites.length, 0, 'B’s mapping still lists pat.morgan, so B sends nothing');
});

test('9. deleting taylor.brooks in A DELETEs the Keycloak user', async () => {
  await admin(A, 'DELETE', `/users/${A.userIds.get('taylor.brooks@contoso.test')}`);
  const summary = await cycle(A);
  assertCycle(summary);
  assert.equal(summary.counts.deleted, 1);
  assert.equal((await kcUsers()).has('taylor.brooks@contoso.test'), false);
  assert.deepEqual(await kcMembers('Contoso Sales'), ['robin.chen@partner.test']);
});

test('10. deleting shared pat.morgan in A removes it for B until B restarts', async () => {
  const before = (await kcUsers()).get('pat.morgan@partner.test');
  assert.ok(before);
  await admin(A, 'DELETE', `/users/${A.userIds.get('pat.morgan@partner.test')}`);
  assertCycle(await cycle(A));
  assert.equal((await kcUsers()).has('pat.morgan@partner.test'), false);

  const bQuiet = await cycle(B);
  const bWrites = (await logs(B, bQuiet.id)).filter((l) => l.method !== 'GET');
  assert.equal(bWrites.length, 0, 'B’s mapping is stale, so it sends nothing');

  const restart = await job(B, 'restart');
  assertCycle(restart);
  const after = (await kcUsers()).get('pat.morgan@partner.test');
  assert.ok(after, 'restart must re-create pat.morgan');
  assert.notEqual(after.id, before.id);
});

test('11. legacy dialect smoke (records Keycloak’s behaviour, never fails the suite)', async (t) => {
  await admin(B, 'PUT', `/apps/${B.appId}/provisioning`, {
    enabled: true,
    tenantUrl: SCIM_BASE,
    scope: { type: 'all' },
    patchDialect: 'legacy',
  });
  await admin(B, 'PATCH', `/users/${B.userIds.get('casey.ng@fabrikam.test')}`, {
    displayName: 'Casey Ng (legacy)',
  });
  const summary = await cycle(B);
  const casey = (await kcUsers()).get('casey.ng@fabrikam.test');
  t.diagnostic(
    `legacy PATCH outcome=${summary.outcome}; Keycloak displayName=${casey?.displayName}`,
  );
});

test('12. the Keycloak token never appears in admin responses or logs', async () => {
  for (const inst of [A, B]) {
    const bodies = [
      await admin(inst, 'GET', `/apps/${inst.appId}/provisioning`),
      await admin(inst, 'GET', `/apps/${inst.appId}/provisioning/logs?top=200`),
      await admin(inst, 'GET', `/apps/${inst.appId}/provisioning/objects?top=200`),
    ];
    assert.equal(JSON.stringify(bodies).includes(token), false, `${inst.label} leaked the token`);
  }
});
