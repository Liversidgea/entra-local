import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type {
  CycleCounts,
  CycleTrigger,
  Group,
  PatchDialect,
  ProvisionedObject,
  ProvisionedObjectType,
  ProvisioningAction,
  ProvisioningConfig,
  ProvisioningCycle,
  User,
} from '../store/types.js';
import {
  addMemberOperations,
  attributeOperations,
  changedKeys,
  escapeFilterValue,
  flattenGroupResource,
  flattenUserResource,
  groupAttrs,
  groupResource,
  patchBody,
  removeMemberOperations,
  userAttrs,
  userResource,
  type FlatAttrs,
  type PatchOperation,
} from './mapping.js';
import {
  listResources,
  scimRequest,
  targetUrl,
  type ScimResponse,
  type ScimTarget,
} from './scimClient.js';

/**
 * SCIM outbound provisioning engine (spec `2026-10-12_scim-outbound-provisioning`): emulates the
 * Entra provisioning service as a SCIM *client*. A cycle reconciles the in-scope directory against
 * the last-synced state in `provisioning_objects` and sends only the SCIM calls needed. Users are
 * processed before groups so memberships can reference the users' SCIM ids. Requests run
 * sequentially per app; one job (cycle / on-demand) per app at a time.
 */

/** Request/response bodies are truncated to this many characters in the provisioning log. */
export const LOG_BODY_LIMIT = 8 * 1024;

export class ProvisioningConflictError extends Error {
  constructor(
    readonly reason: 'busy' | 'disabled',
    message: string,
  ) {
    super(message);
    this.name = 'ProvisioningConflictError';
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  statusCode: number | null;
  message: string;
}

export interface ProvisioningEngine {
  /** Entra's "Test Connection" probe. Logged against `appId` when the app has a config. */
  testConnection(target: ScimTarget, appId?: string): Promise<ConnectionTestResult>;
  /** Run an incremental (`manual`/`auto`) or full (`restart`) cycle. */
  runCycle(appId: string, trigger: Exclude<CycleTrigger, 'on-demand'>): Promise<ProvisioningCycle>;
  /** Provision a single user (plus their memberships in already-provisioned groups). */
  provisionOnDemand(appId: string, userId: string): Promise<ProvisioningCycle>;
  /** Whether a job is currently running for the app. */
  isRunning(appId: string): boolean;
}

/** Abort the cycle: the target is unreachable or rejected our credentials. */
class FatalTargetError extends Error {}

interface Context {
  appId: string;
  cycleId: string;
  target: ScimTarget;
  dialect: PatchDialect;
  counts: CycleCounts;
}

interface Scope {
  users: Map<string, User>;
  groups: Map<string, Group>;
}

function emptyCounts(): CycleCounts {
  return { created: 0, updated: 0, disabled: 0, deleted: 0, skipped: 0, failed: 0 };
}

function truncate(text: string | null | undefined): string | null {
  if (text == null || text === '') return null;
  return text.length > LOG_BODY_LIMIT ? `${text.slice(0, LOG_BODY_LIMIT)}…[truncated]` : text;
}

function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function describeFailure(res: ScimResponse): string {
  if (res.status === null) return res.error ?? 'No response from the SCIM endpoint.';
  const detail = res.json?.detail;
  return typeof detail === 'string' ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

export function createProvisioningEngine(store: Store): ProvisioningEngine {
  const running = new Set<string>();

  function toTarget(config: ProvisioningConfig): ScimTarget {
    return {
      tenantUrl: config.tenantUrl,
      secretToken: config.secretToken,
      allowInsecureTls: config.allowInsecureTls,
    };
  }

  /** Resolve the in-scope users and groups for the config. */
  function resolveScope(config: ProvisioningConfig): Scope {
    const users = new Map<string, User>();
    const groups = new Map<string, Group>();
    if (config.scope.type === 'all') {
      const userCount = store.users.count();
      for (const u of store.users.list({ top: Math.max(userCount, 1), skip: 0 })) users.set(u.id, u);
      const groupCount = store.groups.count();
      for (const g of store.groups.list({ top: Math.max(groupCount, 1), skip: 0 })) {
        groups.set(g.id, g);
      }
    } else {
      for (const groupId of config.scope.groupIds) {
        const group = store.groups.getById(groupId);
        if (!group) continue;
        groups.set(group.id, group);
        for (const member of store.groups.listMembers(group.id)) users.set(member.id, member);
      }
    }
    return { users, groups };
  }

  /** Send one request and log it. Throws {@link FatalTargetError} on no-response / 401 / 403. */
  async function send(
    ctx: Context,
    meta: { objectType: ProvisionedObjectType; sourceId: string; action: ProvisioningAction },
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    treatAsSuccess: (status: number | null) => boolean = isSuccess,
  ): Promise<ScimResponse> {
    const url = targetUrl(ctx.target, path);
    const res = await scimRequest(ctx.target, method, url, body);
    const ok = treatAsSuccess(res.status);
    store.provisioning.addLog({
      appId: ctx.appId,
      cycleId: ctx.cycleId,
      objectType: meta.objectType,
      sourceId: meta.sourceId,
      action: meta.action,
      method,
      url,
      statusCode: res.status,
      outcome: ok ? 'success' : 'failure',
      errorMessage: ok ? null : describeFailure(res),
      requestBody: truncate(body === undefined ? null : JSON.stringify(body)),
      responseBody: truncate(res.text),
    });
    if (res.status === null || res.status === 401 || res.status === 403) {
      throw new FatalTargetError(describeFailure(res));
    }
    return res;
  }

  function logSkip(
    ctx: Context,
    objectType: ProvisionedObjectType,
    sourceId: string,
    reason: string,
  ): void {
    store.provisioning.addLog({
      appId: ctx.appId,
      cycleId: ctx.cycleId,
      objectType,
      sourceId,
      action: 'skip',
      method: '-',
      url: '',
      statusCode: null,
      outcome: 'skipped',
      errorMessage: reason,
      requestBody: null,
      responseBody: null,
    });
    ctx.counts.skipped++;
  }

  function saveObject(
    ctx: Context,
    type: ProvisionedObjectType,
    sourceId: string,
    targetId: string,
    attrs: FlatAttrs,
    memberIds: string[] | null = null,
  ): void {
    store.provisioning.upsertObject({
      appId: ctx.appId,
      objectType: type,
      sourceId,
      targetId,
      state: type === 'user' && attrs.active === false ? 'disabled' : 'active',
      attrs,
      memberIds,
    });
  }

  async function patch(
    ctx: Context,
    type: ProvisionedObjectType,
    sourceId: string,
    targetId: string,
    action: ProvisioningAction,
    operations: PatchOperation[],
  ): Promise<boolean> {
    const resource = type === 'user' ? 'Users' : 'Groups';
    const res = await send(
      ctx,
      { objectType: type, sourceId, action },
      'PATCH',
      `/${resource}/${encodeURIComponent(targetId)}`,
      patchBody(operations),
    );
    return isSuccess(res.status);
  }

  // --- Users -------------------------------------------------------------------------------------

  async function provisionUser(ctx: Context, user: User): Promise<void> {
    const desired = userAttrs(user);
    const mapping = store.provisioning.getObject(ctx.appId, 'user', user.id);

    if (!mapping) {
      if (!user.accountEnabled) {
        logSkip(ctx, 'user', user.id, 'disabled_not_created');
        return;
      }
      const filter = `userName eq "${escapeFilterValue(user.userPrincipalName)}"`;
      const query = await send(
        ctx,
        { objectType: 'user', sourceId: user.id, action: 'query' },
        'GET',
        `/Users?filter=${encodeURIComponent(filter)}`,
      );
      const found = isSuccess(query.status) ? listResources(query.json) : undefined;
      if (found === undefined) {
        ctx.counts.failed++;
        return;
      }
      const match = found[0];
      if (match && typeof match.id === 'string') {
        // Adopt the existing resource; PATCH only what differs from the desired state.
        const current = flattenUserResource(match);
        const keys = changedKeys(current, desired);
        if (keys.length === 0) {
          saveObject(ctx, 'user', user.id, match.id, desired);
          ctx.counts.skipped++;
          return;
        }
        const ok = await patch(
          ctx,
          'user',
          user.id,
          match.id,
          'update',
          attributeOperations(desired, keys, ctx.dialect),
        );
        saveObject(ctx, 'user', user.id, match.id, ok ? desired : current);
        if (ok) ctx.counts.updated++;
        else ctx.counts.failed++;
        return;
      }
      const created = await send(
        ctx,
        { objectType: 'user', sourceId: user.id, action: 'create' },
        'POST',
        '/Users',
        userResource(desired),
      );
      const targetId = created.json?.id;
      if (isSuccess(created.status) && typeof targetId === 'string') {
        saveObject(ctx, 'user', user.id, targetId, desired);
        ctx.counts.created++;
      } else {
        ctx.counts.failed++;
      }
      return;
    }

    const keys = changedKeys(mapping.attrs, desired);
    if (keys.length === 0) {
      ctx.counts.skipped++;
      return;
    }
    const disabling = keys.length === 1 && keys[0] === 'active' && desired.active === false;
    const ok = await patch(
      ctx,
      'user',
      user.id,
      mapping.targetId,
      disabling ? 'disable' : 'update',
      attributeOperations(desired, keys, ctx.dialect),
    );
    if (!ok) {
      ctx.counts.failed++;
      return;
    }
    saveObject(ctx, 'user', user.id, mapping.targetId, desired);
    if (disabling) ctx.counts.disabled++;
    else ctx.counts.updated++;
  }

  /** A mapped user that still exists but left the scope: soft-disable (`active=false`). */
  async function disableOutOfScopeUser(ctx: Context, mapping: ProvisionedObject): Promise<void> {
    if (mapping.attrs.active === false) return;
    const attrs = { ...mapping.attrs, active: false };
    const ok = await patch(
      ctx,
      'user',
      mapping.sourceId,
      mapping.targetId,
      'disable',
      attributeOperations(attrs, ['active'], ctx.dialect),
    );
    if (!ok) {
      ctx.counts.failed++;
      return;
    }
    saveObject(ctx, 'user', mapping.sourceId, mapping.targetId, attrs);
    ctx.counts.disabled++;
  }

  async function deleteTarget(ctx: Context, mapping: ProvisionedObject): Promise<void> {
    const resource = mapping.objectType === 'user' ? 'Users' : 'Groups';
    const res = await send(
      ctx,
      { objectType: mapping.objectType, sourceId: mapping.sourceId, action: 'delete' },
      'DELETE',
      `/${resource}/${encodeURIComponent(mapping.targetId)}`,
      undefined,
      (status) => isSuccess(status) || status === 404,
    );
    if (isSuccess(res.status) || res.status === 404) {
      store.provisioning.deleteObject(ctx.appId, mapping.objectType, mapping.sourceId);
      ctx.counts.deleted++;
    } else {
      ctx.counts.failed++;
    }
  }

  // --- Groups ------------------------------------------------------------------------------------

  /** Source ids of the group's members that are in scope and provisioned (have a SCIM id). */
  function desiredMembers(group: Group, scope: Scope, userTargets: Map<string, string>): string[] {
    return store.groups
      .listMembers(group.id)
      .map((m) => m.id)
      .filter((id) => scope.users.has(id) && userTargets.has(id));
  }

  async function provisionGroup(
    ctx: Context,
    group: Group,
    members: string[],
    userTargets: Map<string, string>,
  ): Promise<void> {
    const desired = groupAttrs(group);
    const mapping = store.provisioning.getObject(ctx.appId, 'group', group.id);
    const targetsOf = (ids: string[]) => ids.map((id) => userTargets.get(id) as string);

    if (!mapping) {
      const filter = `displayName eq "${escapeFilterValue(group.displayName)}"`;
      const query = await send(
        ctx,
        { objectType: 'group', sourceId: group.id, action: 'query' },
        'GET',
        `/Groups?filter=${encodeURIComponent(filter)}&excludedAttributes=members`,
      );
      const found = isSuccess(query.status) ? listResources(query.json) : undefined;
      if (found === undefined) {
        ctx.counts.failed++;
        return;
      }
      const match = found[0];
      if (match && typeof match.id === 'string') {
        // Adopt: Entra doesn't read the target's members, so it adds every expected member.
        const current = flattenGroupResource(match);
        const operations = [
          ...attributeOperations(desired, changedKeys(current, desired), ctx.dialect),
          ...addMemberOperations(targetsOf(members), ctx.dialect),
        ];
        if (operations.length === 0) {
          saveObject(ctx, 'group', group.id, match.id, desired, members);
          ctx.counts.skipped++;
          return;
        }
        const ok = await patch(ctx, 'group', group.id, match.id, 'update', operations);
        if (ok) {
          saveObject(ctx, 'group', group.id, match.id, desired, members);
          ctx.counts.updated++;
        } else {
          saveObject(ctx, 'group', group.id, match.id, current, []);
          ctx.counts.failed++;
        }
        return;
      }
      const created = await send(
        ctx,
        { objectType: 'group', sourceId: group.id, action: 'create' },
        'POST',
        '/Groups',
        groupResource(desired),
      );
      const targetId = created.json?.id;
      if (!isSuccess(created.status) || typeof targetId !== 'string') {
        ctx.counts.failed++;
        return;
      }
      // Like Entra: create the group bare, then add its members with a PATCH. If that PATCH fails
      // the group is mapped with no members, so the next cycle retries the additions.
      if (members.length > 0) {
        const ok = await patch(
          ctx,
          'group',
          group.id,
          targetId,
          'update',
          addMemberOperations(targetsOf(members), ctx.dialect),
        );
        if (!ok) {
          saveObject(ctx, 'group', group.id, targetId, desired, []);
          ctx.counts.failed++;
          return;
        }
      }
      saveObject(ctx, 'group', group.id, targetId, desired, members);
      ctx.counts.created++;
      return;
    }

    const previous = new Set(mapping.memberIds ?? []);
    const wanted = new Set(members);
    const added = members.filter((id) => !previous.has(id));
    // Departed members whose user mapping is gone (deleted on the target) need no call.
    const removed = [...previous].filter((id) => !wanted.has(id) && userTargets.has(id));
    const operations = [
      ...attributeOperations(desired, changedKeys(mapping.attrs, desired), ctx.dialect),
      ...addMemberOperations(targetsOf(added), ctx.dialect),
      ...removeMemberOperations(targetsOf(removed), ctx.dialect),
    ];
    if (operations.length === 0) {
      if (previous.size !== wanted.size || added.length > 0) {
        saveObject(ctx, 'group', group.id, mapping.targetId, desired, members);
      }
      ctx.counts.skipped++;
      return;
    }
    const ok = await patch(ctx, 'group', group.id, mapping.targetId, 'update', operations);
    if (!ok) {
      ctx.counts.failed++;
      return;
    }
    saveObject(ctx, 'group', group.id, mapping.targetId, desired, members);
    ctx.counts.updated++;
  }

  function userTargetMap(appId: string): Map<string, string> {
    return new Map(
      store.provisioning.listObjects(appId, 'user').map((o) => [o.sourceId, o.targetId]),
    );
  }

  // --- Jobs --------------------------------------------------------------------------------------

  async function runJob(
    config: ProvisioningConfig,
    trigger: CycleTrigger,
    body: (ctx: Context) => Promise<void>,
  ): Promise<ProvisioningCycle> {
    const appId = config.appId;
    if (running.has(appId)) {
      throw new ProvisioningConflictError('busy', 'A provisioning job is already running.');
    }
    running.add(appId);
    try {
      const cycleId = randomUUID();
      store.provisioning.startCycle(appId, cycleId, trigger);
      const ctx: Context = {
        appId,
        cycleId,
        target: toTarget(config),
        dialect: config.patchDialect,
        counts: emptyCounts(),
      };
      let fatal = false;
      try {
        await body(ctx);
      } catch (err) {
        if (!(err instanceof FatalTargetError)) throw err;
        fatal = true;
      }
      const outcome = fatal ? 'failed' : ctx.counts.failed > 0 ? 'partial' : 'success';
      const cycle = store.provisioning.finishCycle(cycleId, outcome, ctx.counts);
      store.provisioning.pruneLogs(appId);
      return cycle;
    } finally {
      running.delete(appId);
    }
  }

  async function fullCycle(ctx: Context, config: ProvisioningConfig): Promise<void> {
    const scope = resolveScope(config);

    for (const user of scope.users.values()) await provisionUser(ctx, user);
    for (const mapping of store.provisioning.listObjects(ctx.appId, 'user')) {
      if (scope.users.has(mapping.sourceId)) continue;
      if (store.users.getById(mapping.sourceId)) await disableOutOfScopeUser(ctx, mapping);
      else await deleteTarget(ctx, mapping);
    }

    const userTargets = userTargetMap(ctx.appId);
    for (const group of scope.groups.values()) {
      await provisionGroup(ctx, group, desiredMembers(group, scope, userTargets), userTargets);
    }
    for (const mapping of store.provisioning.listObjects(ctx.appId, 'group')) {
      if (!scope.groups.has(mapping.sourceId)) await deleteTarget(ctx, mapping);
    }
  }

  function requireConfig(appId: string): ProvisioningConfig {
    const config = store.provisioning.getConfig(appId);
    if (!config) throw new Error(`No provisioning config for app '${appId}'.`);
    return config;
  }

  return {
    async testConnection(target, appId) {
      const probeName = randomUUID();
      const filter = `userName eq "${probeName}"`;
      const url = targetUrl(target, `/Users?filter=${encodeURIComponent(filter)}`);
      const res = await scimRequest(target, 'GET', url);
      let result: ConnectionTestResult;
      if (res.status === null) {
        result = {
          ok: false,
          statusCode: null,
          message: res.tlsError
            ? `TLS error: ${res.error}. If the SCIM endpoint uses a self-signed certificate, enable "Allow insecure TLS".`
            : `Could not reach the SCIM endpoint: ${res.error}`,
        };
      } else if (res.status === 401 || res.status === 403) {
        result = {
          ok: false,
          statusCode: res.status,
          message: `The SCIM endpoint rejected the secret token (HTTP ${res.status}).`,
        };
      } else if (res.status !== 200) {
        result = {
          ok: false,
          statusCode: res.status,
          message: `Unexpected HTTP ${res.status} from the SCIM endpoint.`,
        };
      } else {
        const resources = listResources(res.json);
        result =
          resources === undefined
            ? { ok: false, statusCode: 200, message: 'The response was not a SCIM ListResponse.' }
            : resources.length > 0
              ? {
                  ok: false,
                  statusCode: 200,
                  message: 'The SCIM endpoint returned results for a filter that should match nothing.',
                }
              : { ok: true, statusCode: 200, message: 'Connection succeeded.' };
      }
      if (appId !== undefined && store.provisioning.getConfig(appId)) {
        store.provisioning.addLog({
          appId,
          cycleId: null,
          objectType: null,
          sourceId: null,
          action: 'probe',
          method: 'GET',
          url,
          statusCode: res.status,
          outcome: result.ok ? 'success' : 'failure',
          errorMessage: result.ok ? null : result.message,
          requestBody: null,
          responseBody: truncate(res.text),
        });
        store.provisioning.pruneLogs(appId);
      }
      return result;
    },

    async runCycle(appId, trigger) {
      const config = requireConfig(appId);
      if (!config.enabled) {
        throw new ProvisioningConflictError('disabled', 'Provisioning is disabled.');
      }
      if (running.has(appId)) {
        throw new ProvisioningConflictError('busy', 'A provisioning job is already running.');
      }
      if (trigger === 'restart') store.provisioning.clearObjects(appId);
      return runJob(config, trigger, (ctx) => fullCycle(ctx, config));
    },

    async provisionOnDemand(appId, userId) {
      const config = requireConfig(appId);
      return runJob(config, 'on-demand', async (ctx) => {
        const scope = resolveScope(config);
        const user = scope.users.get(userId);
        if (!user) {
          logSkip(ctx, 'user', userId, 'out_of_scope');
          return;
        }
        await provisionUser(ctx, user);
        const userTargets = userTargetMap(appId);
        const targetId = userTargets.get(userId);
        if (targetId === undefined) return;
        for (const group of store.groups.listGroupsForUser(userId)) {
          if (!scope.groups.has(group.id)) continue;
          const mapping = store.provisioning.getObject(appId, 'group', group.id);
          if (!mapping || (mapping.memberIds ?? []).includes(userId)) continue;
          const ok = await patch(
            ctx,
            'group',
            group.id,
            mapping.targetId,
            'update',
            addMemberOperations([targetId], ctx.dialect),
          );
          if (!ok) {
            ctx.counts.failed++;
            continue;
          }
          saveObject(ctx, 'group', group.id, mapping.targetId, mapping.attrs, [
            ...(mapping.memberIds ?? []),
            userId,
          ]);
          ctx.counts.updated++;
        }
      });
    },

    isRunning(appId) {
      return running.has(appId);
    },
  };
}
