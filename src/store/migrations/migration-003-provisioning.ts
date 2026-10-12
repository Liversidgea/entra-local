/**
 * Migration 003 — SCIM outbound provisioning (spec `2026-10-12_scim-outbound-provisioning`).
 *
 * Four tables, all owned by an app registration (`ON DELETE CASCADE`), so deleting an app removes
 * its provisioning config, mapped-object state, cycle history and logs:
 * - `app_provisioning`      — per-app target config (tenant URL, secret token, scope, options).
 * - `provisioning_objects`  — source object → SCIM `id` mapping plus the last-synced attributes
 *                             (`attrs`, JSON) used to diff the next cycle. `source_id` deliberately
 *                             has no FK: the mapping must outlive a deleted source to send `DELETE`.
 * - `provisioning_cycles`   — one row per cycle / on-demand job (summary counts as JSON).
 * - `provisioning_logs`     — one row per outbound SCIM request (bodies truncated, no auth header).
 *
 * The secret token is stored in plaintext: unlike client secrets it must be replayed to the target.
 */
export const MIGRATION_003_PROVISIONING = `
CREATE TABLE app_provisioning (
  app_id             TEXT PRIMARY KEY REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  enabled            INTEGER NOT NULL DEFAULT 0,
  tenant_url         TEXT NOT NULL,
  secret_token       TEXT NOT NULL,
  scope_type         TEXT NOT NULL DEFAULT 'all',
  scope_group_ids    TEXT NOT NULL DEFAULT '[]',
  auto_sync          INTEGER NOT NULL DEFAULT 0,
  patch_dialect      TEXT NOT NULL DEFAULT 'compliant',
  allow_insecure_tls INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE provisioning_objects (
  app_id         TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  object_type    TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  state          TEXT NOT NULL,
  attrs          TEXT NOT NULL,
  member_ids     TEXT,
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
  counts      TEXT
);
CREATE INDEX idx_provisioning_cycles_app ON provisioning_cycles(app_id, started_at);

CREATE TABLE provisioning_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL REFERENCES app_registrations(app_id) ON DELETE CASCADE,
  cycle_id      TEXT,
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
CREATE INDEX idx_provisioning_logs_app ON provisioning_logs(app_id, id);
`;
