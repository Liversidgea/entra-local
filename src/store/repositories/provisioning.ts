import type { Database } from '../db.js';
import type {
  CycleCounts,
  CycleOutcome,
  CycleTrigger,
  NewProvisioningLog,
  PatchDialect,
  ProvisionedObject,
  ProvisionedObjectType,
  ProvisioningConfig,
  ProvisioningConfigInput,
  ProvisioningCycle,
  ProvisioningLog,
  ProvisioningScope,
} from '../types.js';
import type { Clock, Row } from '../util.js';
import { asBool, fromBool, optNum, optStr, reqNum, reqStr } from '../util.js';

/** Maximum provisioning log rows retained per app (oldest pruned after each cycle). */
export const LOG_RETENTION = 1000;

function mapConfig(row: Row): ProvisioningConfig {
  const scopeType = reqStr(row, 'scope_type');
  const scope: ProvisioningScope =
    scopeType === 'groups'
      ? { type: 'groups', groupIds: JSON.parse(reqStr(row, 'scope_group_ids')) as string[] }
      : { type: 'all' };
  return {
    appId: reqStr(row, 'app_id'),
    enabled: asBool(row, 'enabled'),
    tenantUrl: reqStr(row, 'tenant_url'),
    secretToken: reqStr(row, 'secret_token'),
    scope,
    autoSync: asBool(row, 'auto_sync'),
    patchDialect: reqStr(row, 'patch_dialect') as PatchDialect,
    allowInsecureTls: asBool(row, 'allow_insecure_tls'),
    createdAt: reqNum(row, 'created_at'),
    updatedAt: reqNum(row, 'updated_at'),
  };
}

function mapObject(row: Row): ProvisionedObject {
  const members = optStr(row, 'member_ids');
  return {
    appId: reqStr(row, 'app_id'),
    objectType: reqStr(row, 'object_type') as ProvisionedObjectType,
    sourceId: reqStr(row, 'source_id'),
    targetId: reqStr(row, 'target_id'),
    state: reqStr(row, 'state') as 'active' | 'disabled',
    attrs: JSON.parse(reqStr(row, 'attrs')) as ProvisionedObject['attrs'],
    memberIds: members == null ? null : (JSON.parse(members) as string[]),
    lastSyncedAt: reqNum(row, 'last_synced_at'),
  };
}

function mapCycle(row: Row): ProvisioningCycle {
  const counts = optStr(row, 'counts');
  return {
    id: reqStr(row, 'id'),
    appId: reqStr(row, 'app_id'),
    trigger: reqStr(row, 'trigger') as CycleTrigger,
    startedAt: reqNum(row, 'started_at'),
    finishedAt: optNum(row, 'finished_at'),
    outcome: optStr(row, 'outcome') as CycleOutcome | null,
    counts: counts == null ? null : (JSON.parse(counts) as CycleCounts),
  };
}

function mapLog(row: Row): ProvisioningLog {
  return {
    id: reqNum(row, 'id'),
    appId: reqStr(row, 'app_id'),
    cycleId: optStr(row, 'cycle_id'),
    at: reqNum(row, 'at'),
    objectType: optStr(row, 'object_type') as ProvisionedObjectType | null,
    sourceId: optStr(row, 'source_id'),
    action: reqStr(row, 'action') as ProvisioningLog['action'],
    method: reqStr(row, 'method'),
    url: reqStr(row, 'url'),
    statusCode: optNum(row, 'status_code'),
    outcome: reqStr(row, 'outcome') as ProvisioningLog['outcome'],
    errorMessage: optStr(row, 'error_message'),
    requestBody: optStr(row, 'request_body'),
    responseBody: optStr(row, 'response_body'),
  };
}

export interface LogQuery {
  cycleId?: string;
  outcome?: ProvisioningLog['outcome'];
  top: number;
  skip: number;
}

export interface ProvisioningRepository {
  getConfig(appId: string): ProvisioningConfig | undefined;
  listConfigs(): ProvisioningConfig[];
  /** Insert or replace the app's config (preserves `createdAt` on replace). */
  upsertConfig(input: ProvisioningConfigInput): ProvisioningConfig;
  /** Delete config plus all mapped objects, cycles and logs for the app. */
  deleteConfig(appId: string): boolean;

  getObject(
    appId: string,
    type: ProvisionedObjectType,
    sourceId: string,
  ): ProvisionedObject | undefined;
  listObjects(appId: string, type?: ProvisionedObjectType): ProvisionedObject[];
  upsertObject(object: Omit<ProvisionedObject, 'lastSyncedAt'>): void;
  deleteObject(appId: string, type: ProvisionedObjectType, sourceId: string): void;
  clearObjects(appId: string): void;

  startCycle(appId: string, id: string, trigger: CycleTrigger): ProvisioningCycle;
  finishCycle(id: string, outcome: CycleOutcome, counts: CycleCounts): ProvisioningCycle;
  lastCycle(appId: string): ProvisioningCycle | undefined;

  addLog(log: Omit<NewProvisioningLog, 'at'>): void;
  listLogs(appId: string, query: LogQuery): ProvisioningLog[];
  countLogs(appId: string, query: Omit<LogQuery, 'top' | 'skip'>): number;
  /** Keep only the newest {@link LOG_RETENTION} log rows for the app. */
  pruneLogs(appId: string): void;
}

export function createProvisioningRepository(db: Database, clock: Clock): ProvisioningRepository {
  const selectConfig = db.prepare('SELECT * FROM app_provisioning WHERE app_id = ?');
  const selectObject = db.prepare(
    'SELECT * FROM provisioning_objects WHERE app_id = ? AND object_type = ? AND source_id = ?',
  );
  const selectCycle = db.prepare('SELECT * FROM provisioning_cycles WHERE id = ?');

  function logFilter(appId: string, query: Omit<LogQuery, 'top' | 'skip'>) {
    const where = ['app_id = ?'];
    const values: string[] = [appId];
    if (query.cycleId) {
      where.push('cycle_id = ?');
      values.push(query.cycleId);
    }
    if (query.outcome) {
      where.push('outcome = ?');
      values.push(query.outcome);
    }
    return { where: where.join(' AND '), values };
  }

  const repo: ProvisioningRepository = {
    getConfig(appId) {
      const row = selectConfig.get(appId) as Row | undefined;
      return row ? mapConfig(row) : undefined;
    },
    listConfigs() {
      return (db.prepare('SELECT * FROM app_provisioning ORDER BY app_id').all() as Row[]).map(
        mapConfig,
      );
    },
    upsertConfig(input) {
      const now = clock();
      db.prepare(
        `INSERT INTO app_provisioning
           (app_id, enabled, tenant_url, secret_token, scope_type, scope_group_ids, auto_sync,
            patch_dialect, allow_insecure_tls, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET
           enabled = excluded.enabled, tenant_url = excluded.tenant_url,
           secret_token = excluded.secret_token, scope_type = excluded.scope_type,
           scope_group_ids = excluded.scope_group_ids, auto_sync = excluded.auto_sync,
           patch_dialect = excluded.patch_dialect,
           allow_insecure_tls = excluded.allow_insecure_tls, updated_at = excluded.updated_at`,
      ).run(
        input.appId,
        fromBool(input.enabled),
        input.tenantUrl,
        input.secretToken,
        input.scope.type,
        JSON.stringify(input.scope.type === 'groups' ? input.scope.groupIds : []),
        fromBool(input.autoSync),
        input.patchDialect,
        fromBool(input.allowInsecureTls),
        now,
        now,
      );
      return repo.getConfig(input.appId) as ProvisioningConfig;
    },
    deleteConfig(appId) {
      db.prepare('DELETE FROM provisioning_logs WHERE app_id = ?').run(appId);
      db.prepare('DELETE FROM provisioning_cycles WHERE app_id = ?').run(appId);
      db.prepare('DELETE FROM provisioning_objects WHERE app_id = ?').run(appId);
      const result = db.prepare('DELETE FROM app_provisioning WHERE app_id = ?').run(appId);
      return Number(result.changes) > 0;
    },

    getObject(appId, type, sourceId) {
      const row = selectObject.get(appId, type, sourceId) as Row | undefined;
      return row ? mapObject(row) : undefined;
    },
    listObjects(appId, type) {
      const rows = type
        ? db
            .prepare(
              `SELECT * FROM provisioning_objects WHERE app_id = ? AND object_type = ?
                ORDER BY last_synced_at, source_id`,
            )
            .all(appId, type)
        : db
            .prepare(
              `SELECT * FROM provisioning_objects WHERE app_id = ?
                ORDER BY object_type DESC, last_synced_at, source_id`,
            )
            .all(appId);
      return (rows as Row[]).map(mapObject);
    },
    upsertObject(object) {
      db.prepare(
        `INSERT INTO provisioning_objects
           (app_id, object_type, source_id, target_id, state, attrs, member_ids, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id, object_type, source_id) DO UPDATE SET
           target_id = excluded.target_id, state = excluded.state, attrs = excluded.attrs,
           member_ids = excluded.member_ids, last_synced_at = excluded.last_synced_at`,
      ).run(
        object.appId,
        object.objectType,
        object.sourceId,
        object.targetId,
        object.state,
        JSON.stringify(object.attrs),
        object.memberIds == null ? null : JSON.stringify(object.memberIds),
        clock(),
      );
    },
    deleteObject(appId, type, sourceId) {
      db.prepare(
        'DELETE FROM provisioning_objects WHERE app_id = ? AND object_type = ? AND source_id = ?',
      ).run(appId, type, sourceId);
    },
    clearObjects(appId) {
      db.prepare('DELETE FROM provisioning_objects WHERE app_id = ?').run(appId);
    },

    startCycle(appId, id, trigger) {
      db.prepare(
        'INSERT INTO provisioning_cycles (id, app_id, trigger, started_at) VALUES (?, ?, ?, ?)',
      ).run(id, appId, trigger, clock());
      return mapCycle(selectCycle.get(id) as Row);
    },
    finishCycle(id, outcome, counts) {
      db.prepare(
        'UPDATE provisioning_cycles SET finished_at = ?, outcome = ?, counts = ? WHERE id = ?',
      ).run(clock(), outcome, JSON.stringify(counts), id);
      return mapCycle(selectCycle.get(id) as Row);
    },
    lastCycle(appId) {
      const row = db
        .prepare(
          `SELECT * FROM provisioning_cycles WHERE app_id = ? AND finished_at IS NOT NULL
            ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        )
        .get(appId) as Row | undefined;
      return row ? mapCycle(row) : undefined;
    },

    addLog(log) {
      db.prepare(
        `INSERT INTO provisioning_logs
           (app_id, cycle_id, at, object_type, source_id, action, method, url, status_code,
            outcome, error_message, request_body, response_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        log.appId,
        log.cycleId,
        clock(),
        log.objectType,
        log.sourceId,
        log.action,
        log.method,
        log.url,
        log.statusCode,
        log.outcome,
        log.errorMessage,
        log.requestBody,
        log.responseBody,
      );
    },
    listLogs(appId, query) {
      const { where, values } = logFilter(appId, query);
      return (
        db
          .prepare(
            `SELECT * FROM provisioning_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
          )
          .all(...values, query.top, query.skip) as Row[]
      ).map(mapLog);
    },
    countLogs(appId, query) {
      const { where, values } = logFilter(appId, query);
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM provisioning_logs WHERE ${where}`)
        .get(...values) as Row;
      return reqNum(row, 'n');
    },
    pruneLogs(appId) {
      db.prepare(
        `DELETE FROM provisioning_logs WHERE app_id = ? AND id NOT IN (
           SELECT id FROM provisioning_logs WHERE app_id = ? ORDER BY id DESC LIMIT ?)`,
      ).run(appId, appId, LOG_RETENTION);
    },
  };
  return repo;
}
