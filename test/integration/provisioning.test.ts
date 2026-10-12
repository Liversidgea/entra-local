import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/buildTestApp.js';
import { startScimTarget, type ScimTarget } from '../helpers/scimTarget.js';

/**
 * Integration tests for SCIM outbound provisioning (spec `2026-10-12_scim-outbound-provisioning`).
 * Drives the admin API in-process via `app.inject`; the emulator provisions over real HTTP into the
 * in-process SCIM test double.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

let ctx: TestApp | undefined;
let target: ScimTarget | undefined;
afterEach(async () => {
  await ctx?.close();
  await target?.close();
  ctx = undefined;
  target = undefined;
});

interface Fixture {
  ctx: TestApp;
  target: ScimTarget;
  appId: string;
  users: Record<'ann' | 'ben' | 'cat' | 'dan', string>;
  groups: Record<'eng' | 'ops', string>;
}

async function api(method: string, url: string, payload?: unknown) {
  const res = await ctx!.inject({
    method: method as 'GET',
    url,
    ...(payload !== undefined ? { headers: JSON_HEADERS, payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? (res.json() as Record<string, any>) : null };
}

async function createUser(upn: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await api('POST', '/admin/api/users', {
    userPrincipalName: upn,
    displayName: upn.split('@')[0],
    mail: upn,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body!.id as string;
}

async function createGroup(name: string, memberIds: string[]): Promise<string> {
  const res = await api('POST', '/admin/api/groups', { displayName: name });
  expect(res.status).toBe(201);
  for (const userId of memberIds) {
    await api('POST', `/admin/api/groups/${res.body!.id}/members`, { userId });
  }
  return res.body!.id as string;
}

/**
 * Empty directory (tenant preserved) with ann, ben, cat (disabled), dan (no mail/given name); group
 * Engineering {ann, ben, cat} and Ops {dan}; one app with provisioning configured to the target.
 */
async function setup(
  config: Record<string, unknown> = {},
  targetOptions: Parameters<typeof startScimTarget>[0] = {},
): Promise<Fixture> {
  ctx = await buildTestApp();
  target = await startScimTarget(targetOptions);
  ctx.app.store.reset({ reseed: false });
  const ann = await createUser('ann@contoso.test', { givenName: 'Ann', surname: 'Archer' });
  const ben = await createUser('ben@contoso.test');
  const cat = await createUser('cat@contoso.test', { accountEnabled: false });
  const dan = await api('POST', '/admin/api/users', {
    userPrincipalName: 'dan@contoso.test',
    displayName: 'Dan',
  });
  const eng = await createGroup('Engineering', [ann, ben, cat]);
  const ops = await createGroup('Ops', [dan.body!.id as string]);
  const app = await api('POST', '/admin/api/apps', { displayName: 'SCIM app' });
  const appId = app.body!.id as string;
  const put = await api('PUT', `/admin/api/apps/${appId}/provisioning`, {
    enabled: true,
    tenantUrl: `${target.url}/`,
    secretToken: target.token,
    ...config,
  });
  expect(put.status).toBe(200);
  return {
    ctx,
    target,
    appId,
    users: { ann, ben, cat, dan: dan.body!.id as string },
    groups: { eng, ops },
  };
}

const cycle = (appId: string) => api('POST', `/admin/api/apps/${appId}/provisioning/cycles`);

function scimUser(t: ScimTarget, userName: string) {
  return [...t.users.values()].find((u) => u.userName === userName);
}

function scimGroup(t: ScimTarget, displayName: string) {
  return [...t.groups.values()].find((g) => g.displayName === displayName);
}

describe('Provisioning config', () => {
  it('round-trips PUT/GET and never exposes the secret token', async () => {
    const f = await setup();
    const get = await api('GET', `/admin/api/apps/${f.appId}/provisioning`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      enabled: true,
      tenantUrl: f.target.url, // trailing slash stripped
      hasSecretToken: true,
      scope: { type: 'all' },
      autoSync: false,
      patchDialect: 'compliant',
      allowInsecureTls: false,
      lastCycle: null,
      inFlight: false,
    });
    expect(JSON.stringify(get.body)).not.toContain(f.target.token);

    // Omitting secretToken on replace keeps the stored one.
    const put = await api('PUT', `/admin/api/apps/${f.appId}/provisioning`, {
      enabled: true,
      tenantUrl: f.target.url,
      patchDialect: 'legacy',
    });
    expect(put.status).toBe(200);
    expect(put.body!.patchDialect).toBe('legacy');
    expect((await cycle(f.appId)).body!.outcome).toBe('success');

    // Nothing in any response or log row contains the token.
    const logs = await api('GET', `/admin/api/apps/${f.appId}/provisioning/logs?top=200`);
    expect(JSON.stringify(logs.body)).not.toContain(f.target.token);
    expect(f.target.requests.every((r) => r.authorization === `Bearer ${f.target.token}`)).toBe(
      true,
    );
  });

  it('validates input: missing token on create, unknown scoped group, unknown app', async () => {
    const f = await setup();
    const other = await api('POST', '/admin/api/apps', { displayName: 'Other' });
    const noToken = await api('PUT', `/admin/api/apps/${other.body!.id}/provisioning`, {
      tenantUrl: 'http://127.0.0.1:1/scim',
    });
    expect(noToken.status).toBe(400);
    expect(noToken.body!.error.target).toBe('secretToken');

    const badGroup = await api('PUT', `/admin/api/apps/${f.appId}/provisioning`, {
      tenantUrl: f.target.url,
      scope: { type: 'groups', groupIds: ['nope'] },
    });
    expect(badGroup.status).toBe(400);
    expect(badGroup.body!.error.code).toBe('invalid_reference');

    expect((await api('GET', '/admin/api/apps/missing/provisioning')).status).toBe(404);
    expect((await api('GET', `/admin/api/apps/${other.body!.id}/provisioning`)).status).toBe(404);
  });
});

describe('Test connection', () => {
  it('reports success for an empty ListResponse and sends Entra’s probe', async () => {
    const f = await setup();
    const res = await api('POST', `/admin/api/apps/${f.appId}/provisioning/test-connection`);
    expect(res.body).toMatchObject({ ok: true, statusCode: 200 });
    const probe = f.target.requests.at(-1)!;
    expect(probe.method).toBe('GET');
    expect(probe.path).toBe('/Users');
    expect(probe.filter).toMatch(/^userName eq "[0-9a-f-]{36}"$/);
  });

  it('reports a rejected token, an unreachable endpoint, and unsaved values', async () => {
    const f = await setup();
    const bad = await api('POST', `/admin/api/apps/${f.appId}/provisioning/test-connection`, {
      secretToken: 'wrong',
    });
    expect(bad.body).toMatchObject({ ok: false, statusCode: 401 });
    expect(bad.body!.message).toMatch(/secret token/i);

    const down = await api('POST', `/admin/api/apps/${f.appId}/provisioning/test-connection`, {
      tenantUrl: 'http://127.0.0.1:1/scim/v2',
    });
    expect(down.body).toMatchObject({ ok: false, statusCode: null });
  });

  it('fails on a self-signed TLS target until allowInsecureTls is set', async () => {
    const f = await setup({}, { tls: true });
    const strict = await api('POST', `/admin/api/apps/${f.appId}/provisioning/test-connection`);
    expect(strict.body!.ok).toBe(false);
    expect(strict.body!.message).toMatch(/insecure TLS/i);

    const lenient = await api('POST', `/admin/api/apps/${f.appId}/provisioning/test-connection`, {
      allowInsecureTls: true,
    });
    expect(lenient.body!.ok).toBe(true);
  });
});

describe('Provisioning cycles', () => {
  it('first cycle queries then creates users, skips disabled, then creates groups', async () => {
    const f = await setup();
    const res = await cycle(f.appId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      trigger: 'manual',
      outcome: 'success',
      counts: { created: 5, updated: 0, disabled: 0, deleted: 0, failed: 0, skipped: 1 },
    });

    const sequence = f.target.requests.map((r) => `${r.method} ${r.path.split('/')[1]}`);
    expect(sequence).toEqual([
      'GET Users',
      'POST Users',
      'GET Users',
      'POST Users',
      'GET Users',
      'POST Users',
      'GET Groups',
      'POST Groups',
      'PATCH Groups',
      'GET Groups',
      'POST Groups',
      'PATCH Groups',
    ]);
    const groupCreates = f.target.requests.filter(
      (r) => r.method === 'POST' && r.path === '/Groups',
    );
    expect(groupCreates.every((r) => !('members' in r.body!))).toBe(true);
    expect(
      f.target.requests.every(
        (r) => r.method !== 'POST' || r.contentType === 'application/scim+json',
      ),
    ).toBe(true);
    expect(f.target.requests[6]!.query.get('excludedAttributes')).toBe('members');

    expect(scimUser(f.target, 'cat@contoso.test')).toBeUndefined();
    const ann = scimUser(f.target, 'ann@contoso.test')!;
    expect(ann).toMatchObject({
      userName: 'ann@contoso.test',
      active: true,
      displayName: 'ann',
      name: { givenName: 'Ann', familyName: 'Archer' },
      emails: [{ value: 'ann@contoso.test', type: 'work', primary: true }],
      externalId: 'ann',
    });
    const dan = scimUser(f.target, 'dan@contoso.test')!;
    expect(dan).not.toHaveProperty('name');
    expect(dan).not.toHaveProperty('emails');

    const eng = scimGroup(f.target, 'Engineering')!;
    expect(eng.externalId).toBe(f.groups.eng);
    const ben = scimUser(f.target, 'ben@contoso.test')!;
    expect(f.target.memberIds(eng.id).sort()).toEqual([ann.id, ben.id].sort());

    const objects = await api('GET', `/admin/api/apps/${f.appId}/provisioning/objects`);
    expect(objects.body!.count).toBe(5);
    const config = await api('GET', `/admin/api/apps/${f.appId}/provisioning`);
    expect(config.body!.lastCycle.id).toBe(res.body!.id);
  });

  it('a second cycle with no directory changes sends no requests', async () => {
    const f = await setup();
    await cycle(f.appId);
    const before = f.target.requests.length;
    const res = await cycle(f.appId);
    expect(res.body!.counts).toMatchObject({ created: 0, updated: 0, failed: 0 });
    expect(f.target.requests.length).toBe(before);
  });

  it('sends one PATCH replace for a changed attribute and remove for an unset one', async () => {
    const f = await setup();
    await cycle(f.appId);
    const before = f.target.requests.length;
    await api('PATCH', `/admin/api/users/${f.users.ann}`, {
      displayName: 'Ann A.',
      givenName: null,
    });
    const res = await cycle(f.appId);
    expect(res.body!.counts.updated).toBe(1);
    const sent = f.target.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('PATCH');
    expect(sent[0]!.body).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', path: 'displayName', value: 'Ann A.' },
        { op: 'remove', path: 'name.givenName' },
      ],
    });
    expect(scimUser(f.target, 'ann@contoso.test')!.displayName).toBe('Ann A.');
  });

  it.each([
    ['compliant', { op: 'replace', path: 'active', value: false }],
    ['legacy', { op: 'Replace', path: 'active', value: 'False' }],
  ])('disabling a user sends active=false (%s dialect)', async (dialect, expected) => {
    const f = await setup({ patchDialect: dialect });
    await cycle(f.appId);
    const before = f.target.requests.length;
    await api('PATCH', `/admin/api/users/${f.users.ben}`, { accountEnabled: false });
    const res = await cycle(f.appId);
    expect(res.body!.counts.disabled).toBe(1);
    const sent = f.target.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body!.Operations as unknown[])[0]).toEqual(expected);
    expect(scimUser(f.target, 'ben@contoso.test')!.active).toBe(false);
  });

  it('disables (not deletes) a user leaving scope and DELETEs a deleted user', async () => {
    const g = await setup();
    const empty = await api('PUT', `/admin/api/apps/${g.appId}/provisioning`, {
      tenantUrl: g.target.url,
      scope: { type: 'groups', groupIds: [] },
    });
    expect(empty.status).toBe(400);
    await api('PUT', `/admin/api/apps/${g.appId}/provisioning`, {
      enabled: true,
      tenantUrl: g.target.url,
      scope: { type: 'groups', groupIds: [g.groups.eng] },
    });
    await cycle(g.appId);
    expect(scimUser(g.target, 'dan@contoso.test')).toBeUndefined(); // Ops not in scope
    expect(scimGroup(g.target, 'Ops')).toBeUndefined();

    await api('DELETE', `/admin/api/groups/${g.groups.eng}/members/${g.users.ben}`);
    await api('DELETE', `/admin/api/users/${g.users.ann}`);
    const before = g.target.requests.length;
    const res = await cycle(g.appId);
    expect(res.body!.counts).toMatchObject({ disabled: 1, deleted: 1, failed: 0 });
    const sent = g.target.requests.slice(before);
    // ann: DELETE; ben: PATCH active=false; Engineering: PATCH remove ben (ann's membership goes
    // with the deleted user, so no call for it).
    expect(sent.map((r) => `${r.method} ${r.path.split('/')[1]}`).sort()).toEqual([
      'DELETE Users',
      'PATCH Groups',
      'PATCH Users',
    ]);
    const groupPatch = sent.find((r) => r.path.startsWith('/Groups'))!;
    expect(groupPatch.body!.Operations).toHaveLength(1);
    expect(scimUser(g.target, 'ben@contoso.test')!.active).toBe(false);
    expect(scimUser(g.target, 'ann@contoso.test')).toBeUndefined();
  });

  it.each([
    ['compliant', (id: string) => ({ op: 'remove', path: `members[value eq "${id}"]` })],
    ['legacy', (id: string) => ({ op: 'Remove', path: 'members', value: [{ value: id }] })],
  ])('membership add/remove uses the %s dialect', async (dialect, removeOp) => {
    const f = await setup({ patchDialect: dialect });
    await cycle(f.appId);
    const eng = scimGroup(f.target, 'Engineering')!;
    const ben = scimUser(f.target, 'ben@contoso.test')!;
    const dan = scimUser(f.target, 'dan@contoso.test')!;
    await api('DELETE', `/admin/api/groups/${f.groups.eng}/members/${f.users.ben}`);
    await api('POST', `/admin/api/groups/${f.groups.eng}/members`, { userId: f.users.dan });
    const before = f.target.requests.length;
    await cycle(f.appId);
    const sent = f.target.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body!.Operations).toEqual([
      { op: dialect === 'legacy' ? 'Add' : 'add', path: 'members', value: [{ value: dan.id }] },
      removeOp(ben.id),
    ]);
    expect(f.target.memberIds(eng.id)).toContain(dan.id);
    expect(f.target.memberIds(eng.id)).not.toContain(ben.id);
  });

  it('adopts an existing target user by userName instead of POSTing', async () => {
    const f = await setup();
    const existing = f.target.seedUser({
      userName: 'ANN@contoso.test',
      active: true,
      displayName: 'Old Ann',
      name: { givenName: 'Ann', familyName: 'Archer' },
      emails: [{ value: 'ann@contoso.test', type: 'work' }],
      externalId: 'ann',
    });
    await cycle(f.appId);
    const annWrites = f.target
      .writes()
      .filter((r) => r.path === '/Users' || r.path === `/Users/${existing.id}`);
    expect(
      annWrites.filter((r) => r.method === 'POST' && r.body!.userName === 'ann@contoso.test'),
    ).toHaveLength(0);
    const patch = annWrites.find((r) => r.method === 'PATCH')!;
    expect(patch.body!.Operations).toEqual([{ op: 'replace', path: 'displayName', value: 'ann' }]);
    const objects = await api('GET', `/admin/api/apps/${f.appId}/provisioning/objects?type=user`);
    const mapped = (objects.body!.value as { sourceId: string; targetId: string }[]).find(
      (o) => o.sourceId === f.users.ann,
    );
    expect(mapped!.targetId).toBe(existing.id);
  });

  it('restart clears mappings and re-queries every object', async () => {
    const f = await setup();
    await cycle(f.appId);
    const before = f.target.requests.length;
    const res = await api('POST', `/admin/api/apps/${f.appId}/provisioning/restart`);
    expect(res.body!.trigger).toBe('restart');
    const sent = f.target.requests.slice(before);
    expect(sent.filter((r) => r.method === 'GET')).toHaveLength(5);
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(f.target.users.size).toBe(3);
  });

  it('on-demand provisions one in-scope user and skips an out-of-scope one', async () => {
    const f = await setup();
    await api('PUT', `/admin/api/apps/${f.appId}/provisioning`, {
      enabled: false,
      tenantUrl: f.target.url,
      scope: { type: 'groups', groupIds: [f.groups.eng] },
    });
    const ok = await api('POST', `/admin/api/apps/${f.appId}/provisioning/on-demand`, {
      userId: f.users.ann,
    });
    expect(ok.body).toMatchObject({ trigger: 'on-demand', outcome: 'success' });
    expect(ok.body!.counts.created).toBe(1);
    expect([...f.target.users.values()].map((u) => u.userName)).toEqual(['ann@contoso.test']);

    const skipped = await api('POST', `/admin/api/apps/${f.appId}/provisioning/on-demand`, {
      userId: f.users.dan,
    });
    expect(skipped.body!.counts.skipped).toBe(1);
    const logs = await api(
      'GET',
      `/admin/api/apps/${f.appId}/provisioning/logs?cycleId=${skipped.body!.id}`,
    );
    expect(logs.body!.value[0]).toMatchObject({ action: 'skip', errorMessage: 'out_of_scope' });

    const missing = await api('POST', `/admin/api/apps/${f.appId}/provisioning/on-demand`, {
      userId: 'nope',
    });
    expect(missing.status).toBe(400);
  });

  it('a per-object 500 yields partial and retries next cycle; a 401 aborts as failed', async () => {
    const f = await setup();
    f.target.failWhen((r) =>
      r.method === 'POST' && r.body?.userName === 'ben@contoso.test' ? 500 : undefined,
    );
    const partial = await cycle(f.appId);
    expect(partial.body).toMatchObject({ outcome: 'partial' });
    expect(partial.body!.counts.failed).toBe(1);
    expect(scimUser(f.target, 'dan@contoso.test')).toBeDefined();

    f.target.clearRules();
    const retry = await cycle(f.appId);
    expect(retry.body!.outcome).toBe('success');
    expect(scimUser(f.target, 'ben@contoso.test')).toBeDefined();

    await api('PATCH', `/admin/api/users/${f.users.ann}`, { displayName: 'x' });
    await api('PATCH', `/admin/api/users/${f.users.dan}`, { displayName: 'y' });
    f.target.failWhen(() => 401);
    const before = f.target.requests.length;
    const failed = await cycle(f.appId);
    expect(failed.body!.outcome).toBe('failed');
    expect(f.target.requests.length - before).toBe(1);
  });

  it('rejects cycles while disabled or already running', async () => {
    const f = await setup();
    await api('PUT', `/admin/api/apps/${f.appId}/provisioning`, {
      enabled: false,
      tenantUrl: f.target.url,
    });
    const disabled = await cycle(f.appId);
    expect(disabled.status).toBe(409);
    expect(disabled.body!.error.message).toMatch(/disabled/i);

    await api('PUT', `/admin/api/apps/${f.appId}/provisioning`, {
      enabled: true,
      tenantUrl: f.target.url,
    });
    f.target.failWhen(() => 'hang');
    const first = cycle(f.appId);
    await new Promise((r) => setTimeout(r, 200));
    const second = await cycle(f.appId);
    expect(second.status).toBe(409);
    // Closing the target drops the hung connection, so the first cycle ends as failed.
    await f.target.close();
    target = undefined;
    expect((await first).body!.outcome).toBe('failed');
  });

  it('deleting the app or resetting the store removes all provisioning data', async () => {
    const f = await setup();
    await cycle(f.appId);
    const db = f.ctx.app.store.db;
    const count = (table: string) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const tables = [
      'app_provisioning',
      'provisioning_objects',
      'provisioning_cycles',
      'provisioning_logs',
    ];
    expect(count('provisioning_logs')).toBeGreaterThan(0);

    await api('DELETE', `/admin/api/apps/${f.appId}`);
    for (const t of tables) expect(count(t)).toBe(0);

    const app = await api('POST', '/admin/api/apps', { displayName: 'Again' });
    await api('PUT', `/admin/api/apps/${app.body!.id}/provisioning`, {
      enabled: true,
      tenantUrl: f.target.url,
      secretToken: f.target.token,
    });
    await cycle(app.body!.id as string);
    f.ctx.app.store.reset({ reseed: false });
    for (const t of tables) expect(count(t)).toBe(0);
  });

  it('prunes logs to the newest 1000 rows per app', async () => {
    const f = await setup();
    const repo = f.ctx.app.store.provisioning;
    for (let i = 0; i < 1005; i++) {
      repo.addLog({
        appId: f.appId,
        cycleId: null,
        objectType: null,
        sourceId: null,
        action: 'probe',
        method: 'GET',
        url: `x${i}`,
        statusCode: 200,
        outcome: 'success',
        errorMessage: null,
        requestBody: null,
        responseBody: null,
      });
    }
    await cycle(f.appId);
    expect(repo.countLogs(f.appId, {})).toBe(1000);
    expect(repo.listLogs(f.appId, { top: 1, skip: 0 })[0]!.action).not.toBe('probe');
  });
});

describe('Auto-sync', () => {
  it('runs one debounced cycle after a burst of admin directory changes', async () => {
    const f = await setup({ autoSync: true });
    await cycle(f.appId);
    for (const name of ['A', 'B', 'C']) {
      await api('PATCH', `/admin/api/users/${f.users.ann}`, { displayName: name });
    }
    const deadline = Date.now() + 8000;
    let last: Record<string, any> | null = null;
    while (Date.now() < deadline) {
      last = (await api('GET', `/admin/api/apps/${f.appId}/provisioning`)).body;
      if (last?.lastCycle?.trigger === 'auto') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(last?.lastCycle?.trigger).toBe('auto');
    await new Promise((r) => setTimeout(r, 2500));
    const cycles = f.ctx.app.store.db
      .prepare(`SELECT COUNT(*) AS n FROM provisioning_cycles WHERE trigger = 'auto'`)
      .get() as { n: number };
    expect(Number(cycles.n)).toBe(1);
    expect(scimUser(f.target, 'ann@contoso.test')!.displayName).toBe('C');
  });
});
