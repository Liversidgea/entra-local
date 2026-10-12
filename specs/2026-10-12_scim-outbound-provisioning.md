# SCIM Outbound Provisioning (Entra provisioning-service emulation)

- **Issue:** not yet filed.
- **Roadmap ref:** New feature. Not yet on the roadmap; the closest existing item is the *Deferred → Broader Graph* row (directory writes). It builds on the Iteration 1 store and admin surface.
- **Dependencies:** [#2](2026-06-22_02-sqlite-store-schema-seed.md) (store, migrations, reset), [#11](2026-06-22_11-admin-rest-api.md) (admin REST API, error envelope), [#12](2026-06-22_12-web-portal.md) (portal app-detail tabs).
- **Status:** ⬜ Not started.

---

## Goal / outcome

Let a developer test their application's **SCIM 2.0 server** against Entra Local, offline, the same way they would with Microsoft Entra's *application provisioning* service.

In real Entra, SCIM is **outbound**: the provisioning service runs as a SCIM *client* and pushes users and groups from the directory into the app's SCIM endpoint (`/Users`, `/Groups`). It calls that endpoint with a bearer secret token. Entra Local will do the same. For each app registration, a developer configures a **tenant URL** and **secret token**, picks a scope (all users and groups, or selected groups), and runs a provisioning cycle. The emulator then sends Entra-shaped SCIM requests (query, create, update, disable, delete) to the developer's endpoint and records every request and response in a provisioning log.

The value lies in reproducing Entra's **request shapes and sequencing**, including its matching-query-before-create behavior and its PATCH dialect. That way, an app that provisions cleanly against Entra Local is very likely to provision cleanly against real Entra.

---

## Scope

### In scope

- Per-app **provisioning configuration**: enable/disable, tenant URL, secret token (write-only), scope, auto-sync, PATCH dialect, and TLS leniency.
- A **SCIM 2.0 client** (RFC 7643/7644) for the `Users` and `Groups` resources, using Entra's default attribute mappings and matching rules.
- A **reconciliation cycle** that diffs the in-scope directory against the last-synced state and sends the minimal set of SCIM calls: create, update, disable, delete, and group membership add/remove.
- **Triggers:** run a cycle now, restart (clear state, then do a full cycle), provision a single user on demand, and optional debounced **auto-sync** after directory changes made through the admin API.
- **Test connection**, using Entra's probe request.
- **Provisioning logs**: one persisted entry per outbound request, with a capped history per app.
- Admin REST endpoints under `/admin/api/apps/:id/provisioning/*`, plus a portal **Provisioning** tab on the app-detail page.
- Migration `003`, and integration with `store.reset` and app deletion.
- Unit and integration tests against an in-process SCIM test-double server.
- A Docker-based **interop suite**: two Entra Local instances with different, partly overlapping directories, provisioning into one shared Keycloak (native SCIM Realm API) realm on a single Docker network. See [Interop test environment](#interop-test-environment-two-entra-local-instances--keycloak).

### Out of scope

- **Inbound** SCIM (the emulator exposing `/scim/v2/*`). Real Entra doesn't offer this. Directory writes stay on the admin API.
- Entra's *API-driven inbound provisioning* (`/bulkUpload`).
- OAuth-based auth to the target (client credentials or authorization-code grant against the app). Only the bearer **secret token** is supported, which is the default Entra option for non-gallery apps.
- Custom attribute mappings, expression mappings, scoping filters, and enterprise-extension or custom-schema attributes. Default mappings only.
- Enterprise-app user/group **assignment** modeling. "Selected groups" scope stands in for "sync only assigned users and groups".
- Quarantine, escalation emails, scheduled 40-minute cycles, and the 30-day soft-delete window.
- Gallery-app templates, and provisioning to more than one target per app.
- A runnable SCIM server **sample** under `samples/`. Suggested as a follow-up.

---

## Configuration contract

### Resource: `ProvisioningConfig`

One per app registration. It is absent until first saved.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `false` | When `false`, cycles and auto-sync are refused or skipped; on-demand provisioning and test-connection still work. |
| `tenantUrl` | absolute `http(s)` URL | — (required) | The SCIM base URL, for example `https://localhost:5001/scim/v2`. Resource paths are appended (`/Users`, `/Groups`). A trailing `/` is stripped. |
| `secretToken` | string, write-only | — (required on create) | Sent as `Authorization: Bearer <token>`. It's stored in plaintext in the SQLite file, because it must be replayed. It's **never returned** by any endpoint; responses expose `hasSecretToken: boolean` instead. Omitting it on update keeps the stored value. |
| `scope` | `{ type: 'all' }` \| `{ type: 'groups', groupIds: string[] }` | `{ type: 'all' }` | `groups` means: the listed groups, plus their direct members. Unknown group IDs → `400 invalid_reference`. |
| `autoSync` | boolean | `false` | When `true`, a debounced cycle (2 s) runs after admin-API user/group mutations. |
| `patchDialect` | `'compliant'` \| `'legacy'` | `'compliant'` | See [PATCH dialect](#patch-dialect). |
| `allowInsecureTls` | boolean | `false` | Skip TLS certificate verification for this target only. Covers developer SCIM servers that use self-signed certs. |

Read-only status fields returned alongside: `hasSecretToken`, `lastCycle` (`{ id, startedAt, finishedAt, trigger, outcome: 'success'|'partial'|'failed', counts }` or `null`), `inFlight: boolean`.

---

## Admin REST API

All routes are under the existing `/admin` plugin, use the #11 admin error envelope, and are unauthenticated (like the rest of `/admin/api`). `:id` is the app's `appId`. If the app doesn't exist → `404 not_found`.

| Method & path | Purpose | Success |
|---|---|---|
| `GET /admin/api/apps/:id/provisioning` | Read config and status | `200 ProvisioningConfig` or `404 not_found` (not configured) |
| `PUT /admin/api/apps/:id/provisioning` | Create or replace config (zod-validated) | `200` |
| `DELETE /admin/api/apps/:id/provisioning` | Remove config, mapped-object state, and logs. Sends **no** SCIM calls. | `204` |
| `POST /admin/api/apps/:id/provisioning/test-connection` | Run the connection probe (below). Accepts an optional body `{ tenantUrl, secretToken, allowInsecureTls }` so it can test **unsaved** values. | `200 { ok, statusCode, message }` |
| `POST /admin/api/apps/:id/provisioning/cycles` | Run an incremental cycle now. Runs **synchronously** and returns when finished. | `200 CycleSummary` |
| `POST /admin/api/apps/:id/provisioning/restart` | Clear mapped-object state, then run a full cycle (which re-matches every object by query) | `200 CycleSummary` |
| `POST /admin/api/apps/:id/provisioning/on-demand` `{ userId }` | Provision one user (including disable or create as needed), and update that user's memberships in any **already-provisioned** in-scope groups | `200 CycleSummary` |
| `GET /admin/api/apps/:id/provisioning/objects?type=user\|group&skip&top` | Mapped objects: `{ type, sourceId, targetId, state: 'active'\|'disabled', lastSyncedAt }` | `200` paged |
| `GET /admin/api/apps/:id/provisioning/logs?cycleId&outcome&skip&top` | Provisioning log, newest first | `200` paged |

Errors:

- Running a cycle, restart, or on-demand job while one is in flight for the same app → `409 conflict`, with target `provisioning`.
- Cycles or restart when `enabled=false` → `409 conflict`, with the message "Provisioning is disabled".
- An on-demand `userId` that isn't in scope → `200`, where the summary reports a `skipped` action with reason `out_of_scope` (matching Entra's on-demand behavior).

`CycleSummary`:

```jsonc
{
  "id": "…uuid…",
  "trigger": "manual" | "restart" | "on-demand" | "auto",
  "startedAt": "ISO", "finishedAt": "ISO",
  "outcome": "success" | "partial" | "failed",
  "counts": { "created": 0, "updated": 0, "disabled": 0, "deleted": 0, "skipped": 0, "failed": 0 }
}
```

`failed` means the target was unreachable, or returned `401`/`403`, before any object was processed. `partial` means at least one object failed. A failed object is retried in the next cycle, with no in-cycle retries.

---

## SCIM client behavior

### Transport

- Requests carry `Authorization: Bearer <secretToken>`, `Content-Type: application/scim+json`, `Accept: application/scim+json`, and the user agent `Entra-Local-Provisioning/<version>`.
- Responses are accepted as either `application/scim+json` or `application/json`.
- The timeout is 30 s per request. Requests go out sequentially per app; there's no parallelism inside a cycle, so logs stay deterministic.
- Outbound calls go **only** to the configured `tenantUrl` origin. Absolute URLs returned by the target, such as `meta.location`, are never followed.

### Test connection

This matches Entra's "Test Connection" button:

```http
GET {tenantUrl}/Users?filter=userName eq "<random-guid>"
```

`ok` is `true` for a `200` response with a `ListResponse` body where `totalResults` is `0` (or `Resources` is empty). Otherwise `ok` is `false`, and `message` explains why:

- `401`/`403` → the secret token was rejected;
- a network or TLS error → includes the cause, with a hint to set `allowInsecureTls` when the error is a TLS failure;
- a non-SCIM body → the response wasn't a SCIM `ListResponse`.

### Default attribute mappings

**Users** (`urn:ietf:params:scim:schemas:core:2.0:User`):

| SCIM attribute | Source | Notes |
|---|---|---|
| `userName` | `userPrincipalName` | **Matching attribute** |
| `active` | `accountEnabled` | |
| `displayName` | `displayName` | |
| `name.givenName` | `givenName` | omitted when `null` |
| `name.familyName` | `surname` | omitted when `null` |
| `emails[type eq "work"].value` | `mail` | omitted when `null`; `primary: true` |
| `externalId` | UPN local part (the emulator stand-in for `mailNickname`) | |

**Groups** (`urn:ietf:params:scim:schemas:core:2.0:Group`):

| SCIM attribute | Source | Notes |
|---|---|---|
| `displayName` | `displayName` | **Matching attribute** |
| `externalId` | group `id` | |
| `members` | in-scope members that have a mapped user `targetId` | `[{ "value": "<targetId>" }]` |

### Reconciliation cycle

Users are processed first, then groups, so group membership can reference the users' SCIM `id`s. The emulator keeps a mapping `(appId, type, sourceId) → (targetId, state, attrHash)`.

For each **in-scope user**:

1. **Unmapped** → match by querying `GET /Users?filter=userName eq "<upn>"`.
   - If a match is found, adopt its `id`. Compare the returned resource with the desired payload, and `PATCH` only the attributes that differ (none if they're identical). Then store the mapping and hash.
   - If there's no match and the user is enabled, send `POST /Users` with the full payload, then store the `id` the target returns.
   - If there's no match and the user is **disabled**, skip with reason `disabled_not_created` (Entra doesn't create disabled users).
2. **Mapped** with a changed attribute hash → send `PATCH /Users/{id}`, with one operation per changed attribute (see dialect).
3. **Mapped** with no change → no call; count as `skipped`.

For each **mapped user no longer in scope** (removed from the scoped groups, or scope changed): send `PATCH /Users/{id}` setting `active=false`, and set the state to `disabled`. It isn't deleted.

For each **mapped user whose source user was deleted**: send `DELETE /Users/{id}`, then drop the mapping. A `404` from the target counts as success.

For each **in-scope group**:

1. **Unmapped** → match by querying `GET /Groups?filter=displayName eq "<name>"&excludedAttributes=members`.
   - If a match is found, adopt its `id`, then reconcile its membership in full by sending `add` operations for every expected member. (Entra doesn't read the target's member list.)
   - If there's no match, send `POST /Groups` with `displayName`, `externalId`, and `members`.
2. **Mapped** → if the `displayName` changed, send a `PATCH` `replace` on `displayName`. Membership is diffed against the last-synced member set: send a `PATCH` `add` for new members and a `remove` for departed members. Each operation carries at most **50 members**, matching Entra's batching.

For each **mapped group no longer in scope, or deleted** → send `DELETE /Groups/{id}`, then drop the mapping.

The match filter values are escaped according to RFC 7644 §3.4.2.2: `"` and `\` are backslash-escaped.

### PATCH dialect

Real Entra has two PATCH behaviors. Microsoft documents them in *Known issues and resolutions with SCIM 2.0 protocol compliance* (the `aadOptscim062020` feature flag). Developers hit bugs in exactly this area, so both are emulated:

| Aspect | `compliant` (default) | `legacy` |
|---|---|---|
| `op` casing | `add` / `replace` / `remove` | `Add` / `Replace` / `Remove` |
| Boolean values (`active`) | JSON `false` | string `"False"` |
| Group member removal | `{"op":"remove","path":"members[value eq \"<id>\"]"}` | `{"op":"Remove","path":"members","value":[{"value":"<id>"}]}` |
| Single-valued replace | `{"op":"replace","path":"displayName","value":"…"}` | same, `op` capitalised |

**Implementation note:** before coding, check this table against the current Microsoft doc, and record any differences in this spec. The doc is the source of truth for dialect fidelity.

Every PATCH body is shaped like this:

```json
{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": [ … ] }
```

### Auto-sync

The admin plugin calls `provisioning.notifyDirectoryChanged()` after every successful user or group mutation, including membership changes, seed, and reset. For each app where `enabled && autoSync`, this (re)starts a 2-second debounce timer; when the timer fires, a cycle runs with `trigger: 'auto'`. If a cycle is already running, one follow-up cycle is queued. Timers are cleared in the Fastify `onClose` hook. Changes made directly through the repositories (such as tests or seed at startup) don't trigger a sync.

### Logging

Each outbound request writes a log row with these fields:

- `cycleId`, `at`
- `objectType`, `sourceId`
- `action` (`query`, `create`, `update`, `disable`, `delete`, or `probe`)
- `method`, `url`, `statusCode`
- `outcome` (`success`, `skipped`, or `failure`)
- `errorMessage`
- `requestBody` and `responseBody`, each truncated to 8 KB

The `Authorization` header is **never** logged. Each app keeps at most the newest 1,000 rows; older rows are pruned after each cycle.

---

## Data changes — migration `003-provisioning`

```sql
CREATE TABLE app_provisioning (
  app_id             TEXT PRIMARY KEY REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  enabled            INTEGER NOT NULL DEFAULT 0,
  tenant_url         TEXT NOT NULL,
  secret_token       TEXT NOT NULL,
  scope_type         TEXT NOT NULL DEFAULT 'all',      -- 'all' | 'groups'
  scope_group_ids    TEXT NOT NULL DEFAULT '[]',       -- JSON array
  auto_sync          INTEGER NOT NULL DEFAULT 0,
  patch_dialect      TEXT NOT NULL DEFAULT 'compliant',
  allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE provisioning_objects (
  app_id         TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  object_type    TEXT NOT NULL,                        -- 'user' | 'group'
  source_id      TEXT NOT NULL,                        -- no FK: must survive source deletion
  target_id      TEXT NOT NULL,
  state          TEXT NOT NULL,                        -- 'active' | 'disabled'
  attr_hash      TEXT NOT NULL,
  member_ids     TEXT,                                 -- groups: JSON array of synced member source ids
  last_synced_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, object_type, source_id)
);

CREATE TABLE provisioning_cycles (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  outcome     TEXT,
  counts      TEXT                                     -- JSON
);

CREATE TABLE provisioning_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  cycle_id      TEXT NOT NULL,
  at            INTEGER NOT NULL,
  object_type   TEXT,
  source_id     TEXT,
  action        TEXT NOT NULL,
  method        TEXT NOT NULL,
  url           TEXT NOT NULL,
  status_code   INTEGER,
  outcome       TEXT NOT NULL,
  error_message TEXT,
  request_body  TEXT,
  response_body TEXT
);
CREATE INDEX provisioning_logs_app_at ON provisioning_logs(app_id, at DESC);
```

Store integration:

- A new `provisioning` repository is added to `src/store/repositories/` and exposed on `Store`.
- `store.reset` empties all four tables. They count as runtime data, so provisioning config doesn't survive reset, consistent with app registrations.
- The seed adds no provisioning config.

---

## Implementation approach

- **`src/provisioning/`** (new module):
  - `scimClient.ts`: transport, dialect-aware PATCH builders, list parsing, filter escaping. It uses `undici` / `fetch` with a per-target `Agent` for `allowInsecureTls`.
  - `mapping.ts`: the default attribute mappings and attribute hashing.
  - `engine.ts`: scope resolution, the reconciliation cycle, the on-demand job, the per-app in-flight lock, and log writes.
  - `autoSync.ts`: debounce timers.
  - `plugin.ts`: decorates `app.provisioning`, and registers `onClose`.
- **`src/admin/routes.provisioning.ts`**: the routes above, with zod schemas in `schemas.ts` and DTOs in `dto.ts` (the DTO must never contain `secretToken`).
- **Admin user/group routes**: after a successful mutation, call `app.provisioning.notifyDirectoryChanged()`.
- **Clock and IDs**: use the store's injected clock and ID generator, so tests stay deterministic.
- **Portal**: add a **Provisioning** section to `APP_DETAIL_SECTIONS` in `portal/src/routes/AppDetail.tsx`. It includes:
  - a config form: enable switch, tenant URL, write-only secret token field ("•••• saved" when `hasSecretToken`), scope picker with group multi-select, auto-sync, dialect, and insecure-TLS warning;
  - **Test connection**, **Provision now**, **Restart**, and **Provision on demand** (user picker) actions;
  - a last-cycle summary;
  - a paged log table, with a drawer showing request and response bodies.

  Follow `DESIGN.md`. If new UI patterns are needed, flag them to the designer rather than inventing tokens.

---

## Tests

**Test double:** a minimal in-process SCIM server on an ephemeral port (`test/support/scimTarget.ts`). It keeps in-memory Users and Groups, supports `eq` filters on `userName` and `displayName`, `POST`, `PATCH` (applying both dialects), and `DELETE`. It also records every request, and can be scripted to fail specific calls (`401`, `500`, timeout).

**Unit tests:**

- attribute mapping, including null omission;
- hash stability;
- filter escaping;
- PATCH builders for both dialects, member batching at 50, and the remove-member shape per dialect;
- scope resolution for `all` and `groups`.

**Integration tests** (the admin API against the test double):

1. `PUT` then `GET` config round-trips; `secretToken` never appears in any response or log row.
2. Test connection: `200` with an empty list → `ok:true`; `401` → an `ok:false` token message; an unreachable port → `ok:false`; self-signed TLS fails, then passes once `allowInsecureTls` is set.
3. The first cycle over the seed data queries then creates every enabled in-scope user, then creates the groups with their members. The recorded request sequence matches a golden fixture.
4. A second cycle with no changes sends zero writes (queries only for unmapped objects, so none here).
5. Changing a user's `displayName` → exactly one `PATCH replace displayName`.
6. Disabling a user → `PATCH active=false`. The boolean is `false` in compliant mode and `"False"` in legacy mode.
7. Removing a user from the only scoped group → disabled, not deleted; deleting a user in the emulator → `DELETE`.
8. Group membership add/remove produces the correct per-dialect operations.
9. Adopt-existing: a target pre-seeded with a matching `userName` gets no `POST`, and the mapping stores the target's `id`.
10. Restart clears the mappings and re-queries every object.
11. On-demand for an in-scope user creates that user only; on-demand for an out-of-scope user returns `skipped` with reason `out_of_scope`.
12. A per-object `500` → `partial` outcome, other objects still processed, and the object retried next cycle. A `401` on the first call → `failed`, with nothing further sent.
13. A concurrent cycle request → `409`; disabled config → `409`.
14. Auto-sync: an admin `PATCH` on a user triggers exactly one debounced cycle (using fake timers), and multiple rapid edits produce one cycle.
15. Deleting the app cascades to the provisioning config, objects, cycles, and logs. `store.reset` empties all four tables.
16. Log retention prunes to 1,000 rows.

**Portal tests:** the Provisioning tab renders, the secret field is write-only, and the action buttons call the right endpoints (using the existing `installFetch` double, plus an axe check).

No real-MSAL e2e test is needed, because this isn't an auth flow.

---

## Interop test environment (two Entra Local instances → Keycloak)

The in-process test double proves request shapes. This environment proves that Entra Local provisions correctly into a **real, independently written SCIM server**. It also models a realistic multi-tenant situation: two Entra tenants provisioning into **one shared** downstream identity store, with overlapping and near-colliding identities.

### Target: Keycloak's native SCIM Realm API

Keycloak ships its own SCIM 2.0 server (the **SCIM Realm API**, feature flag `scim-api`). It was experimental in 26.6 and was promoted in 26.7 and 26.8. The Keycloak team built it against Microsoft's Entra SCIM Validator, so it's a good stand-in for "an app that works with real Entra". No third-party plugin is needed.

- **Image:** `quay.io/keycloak/keycloak:26.8.0`, pinned. Bump it deliberately, and re-run this suite when you do.
- **Start command:** `start-dev --features=scim-api --import-realm`. The flag is passed explicitly even if 26.8 enables it by default, so the setup doesn't depend on that default.
- **SCIM base URL** (per realm): `http://keycloak:8080/realms/<realm>/scim/v2`.
- **Auth:** the SCIM API uses Keycloak Admin API permissions. Callers present a Keycloak access token from a service-account client that holds `realm-management` roles `manage-users` and `view-realm`.

Entra's provisioning model uses a long-lived static **secret token**, but Keycloak issues short-lived JWTs. To bridge the two, the provisioning client sets the client attribute `access.token.lifespan` to `86400` (24 h). The setup script fetches one token per run and stores it as each Entra instance's `secretToken`. Tokens must be requested from `http://keycloak:8080` (the in-network hostname Entra Local calls), so their issuer matches the host that validates them.

### Docker topology

All services join a single user-defined bridge network, `scim-interop`. Containers reach each other by service name only, and host ports are published purely for debugging.

| Service | Image | In-network address | Host port (debug) | Role |
|---|---|---|---|---|
| `entra-a` | built from repo `Dockerfile` | `https://entra-a:8443` | `18443` | Tenant A, **Contoso** |
| `entra-b` | built from repo `Dockerfile` | `https://entra-b:8443` | `28443` | Tenant B, **Fabrikam** |
| `keycloak` | `quay.io/keycloak/keycloak:26.8.0` | `http://keycloak:8080` | `18080` | Shared SCIM target, realm `shared` |
| `runner` | `node:22-bookworm-slim` with the repo mounted | — | — | Seeds both instances, runs the interop suite, then exits |

Files live under `test/scim-interop/`:

```text
test/scim-interop/
├── docker-compose.yml          # 4 services, network scim-interop, healthchecks, depends_on: service_healthy
├── keycloak/realm-shared.json  # realm import: scimApiEnabled, provisioning client + service-account roles
├── fixtures/tenant-a.json      # Contoso directory (users, groups, memberships)
├── fixtures/tenant-b.json      # Fabrikam directory
├── setup.ts                    # reset → seed fixtures → register app → fetch KC token → PUT provisioning
└── interop.test.ts             # scenario steps + assertions (vitest, sequential)
```

The compose file builds both Entra instances from the same image, with per-instance environment:

```yaml
x-entra: &entra
  build: { context: ../.., dockerfile: Dockerfile }
  networks: [scim-interop]
  environment: &entra-env
    ORIGIN_MODE: compat
    SEED_ON_START: "true"
    LOG_LEVEL: info

services:
  entra-a:
    <<: *entra
    environment: { <<: *entra-env, TENANT_ID: "aaaaaaaa-0000-0000-0000-00000000000a", PUBLIC_ORIGIN: "https://entra-a:8443" }
    ports: ["18443:8443"]
    volumes: [entra-a-data:/app/data]
  entra-b:
    <<: *entra
    environment: { <<: *entra-env, TENANT_ID: "bbbbbbbb-0000-0000-0000-00000000000b", PUBLIC_ORIGIN: "https://entra-b:8443" }
    ports: ["28443:8443"]
    volumes: [entra-b-data:/app/data]
  keycloak:
    image: quay.io/keycloak/keycloak:26.8.0
    command: ["start-dev", "--features=scim-api", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_HEALTH_ENABLED: "true"
    volumes: ["./keycloak:/opt/keycloak/data/import:ro"]
    ports: ["18080:8080"]
    networks: [scim-interop]
    healthcheck:   # image has no curl; probe the management port with bash /dev/tcp
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q '\"UP\"' <&3"]
      interval: 5s
      retries: 40
  runner:
    image: node:22-bookworm-slim
    working_dir: /repo
    volumes: ["../..:/repo"]
    command: ["npx", "vitest", "run", "--config", "vitest.scim-interop.config.ts"]
    networks: [scim-interop]
    depends_on:
      entra-a: { condition: service_healthy }
      entra-b: { condition: service_healthy }
      keycloak: { condition: service_healthy }

networks:
  scim-interop: { driver: bridge }
volumes:
  entra-a-data: {}
  entra-b-data: {}
```

Only the `runner` talks to the Entra admin APIs. It accepts the instances' self-signed certificates **for this suite only** (`NODE_TLS_REJECT_UNAUTHORIZED=0` scoped to the runner container). Entra → Keycloak traffic is plain HTTP inside the network, so `allowInsecureTls` stays `false`.

### Keycloak realm import (`realm-shared.json`)

The import contains:

- realm `shared`, with `enabled: true` and `scimApiEnabled: true`;
- `duplicateEmails` left at its default (`false`), so identical email addresses must resolve to the *same* user;
- confidential client `entra-provisioning`, configured as follows:
  - `serviceAccountsEnabled: true` and `standardFlowEnabled: false`;
  - a fixed test secret, `entra-provisioning-secret`;
  - `attributes."access.token.lifespan": "86400"`;
- user `service-account-entra-provisioning`, with `clientRoles.realm-management: ["manage-users", "view-realm"]`.

### Seed data

Each instance's default seed directory is wiped first with `POST /admin/api/reset { "reseed": false }`, which keeps the tenant row and signing key. This leaves only the fixture identities, so the instances genuinely hold **different** directories. `setup.ts` then creates the following through the admin API:

- the fixture users, groups, and memberships;
- one app registration per instance, `Keycloak SCIM (shared)`;
- that app's provisioning config: `tenantUrl=http://keycloak:8080/realms/shared/scim/v2`, the fetched Keycloak token, `scope: { type: 'all' }`, `autoSync: false`, and `patchDialect: 'compliant'`.

**Users** (all UPNs lowercase, because Keycloak lowercases usernames; `mail` = UPN unless noted):

| UPN | Entra A (Contoso) | Entra B (Fabrikam) | Category |
|---|---|---|---|
| `alex.smith@contoso.test` | ✅ "Alex Smith" | — | **Same local part, different domain** (pairs with the next row) |
| `alex.smith@fabrikam.test` | — | ✅ "Alex Smith" | **Same local part, different domain** |
| `jordan.lee@contoso.test` | ✅ "Jordan Lee" | — | **Same local part, different domain** |
| `jordan.lee@fabrikam.test` | — | ✅ "Jordan Lee" | **Same local part, different domain** |
| `pat.morgan@partner.test` | ✅ "Pat Morgan" | ✅ "Pat Morgan" | **Overlap, identical attributes** |
| `robin.chen@partner.test` | ✅ "Robin Chen" | ✅ "Robin Chen (Fabrikam)" | **Overlap, conflicting `displayName`** |
| `sam.patel@contoso.test` | ✅ `accountEnabled=false` | — | A only (disabled; must **not** be created) |
| `taylor.brooks@contoso.test` | ✅ | — | A only |
| `casey.ng@fabrikam.test` | — | ✅ | B only |

**Groups:**

| Group `displayName` | Entra A members | Entra B members | Category |
|---|---|---|---|
| `Engineering` | alex.smith@contoso, jordan.lee@contoso, pat.morgan | alex.smith@fabrikam, casey.ng, pat.morgan | **Overlapping group name** (matched by `displayName`) |
| `Contoso Sales` | robin.chen, taylor.brooks | — | A only |
| `Fabrikam Ops` | — | robin.chen, jordan.lee@fabrikam | B only |

Each fixture user carries a distinct emulator `id` per instance, so the overlap is by **identity attributes**, never by object ID. The `externalId` mapping (UPN local part) is shared by each same-local-part pair (`alex.smith`, `jordan.lee`) and by each overlap pair. This is deliberate: it checks that the target doesn't use `externalId` as a uniqueness key across tenants, and that Entra Local doesn't match on it.

### Scenario and expected outcomes

The steps run sequentially, A then B, so the results are deterministic. After each step, the suite asserts Keycloak state through Keycloak's own SCIM API (`GET /Users`, `GET /Groups/{id}`), using the runner's own service-account token, and asserts each instance's provisioning log and mapped objects.

| # | Step | Expected outcome |
|---|---|---|
| 1 | **Test connection** on both instances | `ok: true` for both |
| 2 | **Cycle A** | Keycloak has 5 users: alex.smith@contoso, jordan.lee@contoso, pat.morgan, robin.chen ("Robin Chen"), taylor.brooks, and **no** sam.patel (skipped, `disabled_not_created`). It also has groups `Engineering` (3 members) and `Contoso Sales` (2 members). |
| 3 | **Cycle B** | 3 new users: alex.smith@fabrikam, jordan.lee@fabrikam, casey.ng. **pat.morgan and robin.chen are adopted, not duplicated**: B's log shows a matching `GET` that returned 1 result, and **no** `POST`, for them. `Engineering` is adopted by `displayName`, and B adds alex.smith@fabrikam and casey.ng (pat.morgan is already a member, so the add is idempotent). `Fabrikam Ops` is created. Keycloak totals: 8 users, 3 groups, and `Engineering` has 5 members. |
| 4 | **Different-domain integrity** | `alex.smith@contoso.test` and `alex.smith@fabrikam.test` are two distinct Keycloak users with different `id`s and emails; the same holds for the `jordan.lee` pair. No 409 conflicts appear in either log. |
| 5 | **Conflicting overlap** | robin.chen's Keycloak `displayName` is "Robin Chen (Fabrikam)": B adopted the user and PATCHed only the attributes that differed (last writer wins). A's next no-change cycle sends **no** writes, because A diffs against *its own* last-synced hash rather than re-reading the target. This documents real Entra behavior, so it's asserted rather than fixed. |
| 6 | **Idempotence** | Re-running cycle A and then cycle B sends zero write requests. |
| 7 | **Disable in A** | Setting alex.smith@contoso to `accountEnabled=false`, then running cycle A, makes that user `active: false` in Keycloak. alex.smith@fabrikam stays `active: true`. |
| 8 | **Membership removal is tenant-scoped** | Removing pat.morgan from A's `Engineering`, then running cycle A, sends one `remove` op. pat.morgan *is* removed from Keycloak's shared `Engineering`, because both tenants share the target group. B's mapping still lists pat.morgan as synced, so B sends nothing. This shared-target hazard is asserted and listed in the troubleshooting notes. |
| 9 | **Delete in A** | Deleting taylor.brooks in A, then running cycle A, sends `DELETE` and removes the user from Keycloak and from `Contoso Sales`. |
| 10 | **Shared-identity delete** | Deleting pat.morgan in A, then running cycle A, sends `DELETE`, which removes the **shared** Keycloak user. Cycle B then sends no write, because B's mapping is stale. **Restart B** re-queries, finds no match, and re-creates pat.morgan with a **new** Keycloak `id`. |
| 11 | **Legacy dialect smoke** | Switching B to `patchDialect: 'legacy'`, changing casey.ng's `displayName`, and running cycle B: Keycloak accepts the capitalised `Replace` op, or the step records the rejection. The outcome is written into this spec as a compatibility note; it doesn't block the suite. |
| 12 | **Secret hygiene** | The Keycloak token appears in neither instance's admin API responses nor provisioning logs (string search across all `GET` responses). |

### Running it

- **Locally:** `npm run test:scim-interop`, which wraps the following and tears everything down afterwards:

  ```bash
  docker compose -f test/scim-interop/docker-compose.yml up --build --abort-on-container-exit --exit-code-from runner
  ```

  For debugging, run `docker compose ... up entra-a entra-b keycloak`. Then open the portals at `https://localhost:18443` and `https://localhost:28443`, and the Keycloak console at `http://localhost:18080` (`admin`/`admin`). The provisioning logs and Keycloak's users and groups can be inspected side by side.
- **CI:** a separate `scim-interop` job that runs the same command on `ubuntu-latest`. It isn't part of `npm test`, because it needs Docker and takes minutes, not seconds. It's required on PRs that touch `src/provisioning/**`, `src/admin/routes.provisioning.ts`, or `test/scim-interop/**`, and runs nightly otherwise.
- **No external network:** apart from pulling images, nothing leaves the `scim-interop` network.
- **Deterministic:** fixed tenant IDs, fixed client secret, and fixed fixtures. `docker compose down -v` runs in teardown, so each run starts from empty volumes.

---

## Testable acceptance criteria

1. **Configurable target:** an app registration can be given a SCIM tenant URL and secret token through the admin API and the portal. The token is never returned or logged.
2. **Entra-compatible probe:** Test connection sends `GET /Users?filter=userName eq "<guid>"` with the bearer token, and reports success only for an empty SCIM `ListResponse`.
3. **Initial provisioning:** a cycle creates every enabled in-scope user (each preceded by a matching query), then every in-scope group with its members referenced by the SCIM `id`s the target returned.
4. **Incremental updates:** later cycles send only the changes needed: attribute PATCHes, `active=false` for disabled or out-of-scope users, `DELETE` for deleted users and groups, and member add/remove PATCHes.
5. **Idempotence:** a cycle with no directory changes sends no write requests.
6. **Dialects:** `compliant` and `legacy` produce the PATCH shapes in the dialect table.
7. **Scope:** `groups` scope provisions only the selected groups and their direct members.
8. **Triggers:** run-now, restart, on-demand, and debounced auto-sync each behave as specified; concurrent runs are rejected with `409`.
9. **Observability:** every outbound request appears in the provisioning log with method, URL, status, outcome, and truncated bodies. The portal shows the log and the last-cycle summary.
10. **Resilience:** per-object failures don't abort the cycle and are retried in the next one. Auth or connectivity failures end the cycle as `failed`.
11. **Lifecycle:** app deletion and `store.reset` remove all provisioning data. Migration `003` applies cleanly to an existing database.
12. **Real-target interop:** `npm run test:scim-interop` passes. Two Entra Local instances on one Docker network provision their seeded directories into a shared Keycloak 26.8.0 realm, and every outcome in the interop scenario table holds. Overlapping identities are adopted rather than duplicated; same-local-part/different-domain users stay distinct; and disabled users are never created.
13. **DoD:** `lint`, `typecheck`, `build`, and `npm test` are green, and the `scim-interop` CI job is green.

---

## Decisions / assumptions

- **Outbound only.** Entra Local emulates Entra's provisioning *client*, because that's what developers integrate with in real Entra. An inbound `/scim/v2` server was considered and rejected: real Entra has no such endpoint, and directory writes already exist through the admin API.
- **Reconcile against stored state rather than an event stream.** The store has no change events, and a diff-based cycle is idempotent and restart-safe. Auto-sync is just a debounced cycle, not a separate code path.
- **"Selected groups" approximates assignment.** The emulator has no enterprise-app assignment model, and adding one is out of scope.
- **The secret token is stored in plaintext.** It must be replayed to the target, unlike client secrets, which are stored hashed. That's acceptable for a local development tool, and it's documented.
- **Disabled users are not created.** This assumes Entra skips provisioning disabled users that were never provisioned. Verify against real Entra behavior during implementation and adjust if it's wrong.
- **Synchronous cycle endpoints.** Directories are small locally; returning the summary inline keeps tests and portal UX simple. If directory sizes grow, revisit with a job ID and polling.
- **Keycloak as the real-target interop server.** Keycloak 26.8's native SCIM Realm API was built against Microsoft's Entra SCIM Validator, needs no plugin, and runs offline in Docker. Its short-lived tokens are bridged by a 24-hour token lifespan on the test client. Alternatives considered: SCIM plugins for older Keycloak versions (third-party and less maintained), and a hand-written SCIM server (not independent of our own assumptions).
- **One shared target realm for both tenants.** Two separate realms would never exercise identity overlap. A shared realm makes the cross-tenant behavior (adoption, last writer wins, shared-group membership removal, stale mapping after a delete) explicit and asserted.
- **Follow-up candidates:** a `samples/scim-server` reference target with CI smoke; OAuth client-credentials auth to the target; custom attribute mappings.
