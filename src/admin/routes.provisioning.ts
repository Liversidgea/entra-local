import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProvisioningConflictError } from '../provisioning/engine.js';
import type { ProvisioningConfig } from '../store/types.js';
import {
  toCycleSummaryDto,
  toPaged,
  toProvisionedObjectDto,
  toProvisioningConfigDto,
  toProvisioningLogDto,
} from './dto.js';
import { conflict, invalidReference, notFound, validationError } from './errors.js';
import {
  onDemandSchema,
  provisioningLogsQuerySchema,
  provisioningObjectsQuerySchema,
  provisioningPutSchema,
  provisioningTestSchema,
} from './schemas.js';

interface IdParams {
  id: string;
}

/**
 * Register `/admin/api/apps/:id/provisioning/*` — SCIM outbound provisioning config, triggers,
 * mapped objects and logs (spec `2026-10-12_scim-outbound-provisioning`). The secret token is
 * write-only: no response ever contains it.
 */
export function registerProvisioningRoutes(app: FastifyInstance): void {
  const { store, provisioning } = app;

  const requireApp = (id: string): void => {
    if (!store.apps.getByAppId(id)) throw notFound(`No app with id '${id}'.`);
  };

  const requireConfig = (id: string): ProvisioningConfig => {
    requireApp(id);
    const config = store.provisioning.getConfig(id);
    if (!config) throw notFound(`Provisioning is not configured for app '${id}'.`, 'provisioning');
    return config;
  };

  const configDto = (config: ProvisioningConfig) =>
    toProvisioningConfigDto(
      config,
      store.provisioning.lastCycle(config.appId),
      provisioning.isRunning(config.appId),
    );

  /** Map engine conflicts (busy / disabled) onto the admin `409 conflict` envelope. */
  async function runJob<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (err) {
      if (err instanceof ProvisioningConflictError) throw conflict(err.message, 'provisioning');
      throw err;
    }
  }

  app.get('/api/apps/:id/provisioning', (request: FastifyRequest<{ Params: IdParams }>) => {
    return configDto(requireConfig(request.params.id));
  });

  app.put('/api/apps/:id/provisioning', (request: FastifyRequest<{ Params: IdParams }>) => {
    const appId = request.params.id;
    requireApp(appId);
    const body = provisioningPutSchema.parse(request.body);
    const existing = store.provisioning.getConfig(appId);
    const secretToken = body.secretToken ?? existing?.secretToken;
    if (secretToken === undefined) {
      throw validationError(
        'secretToken is required when provisioning is first configured.',
        [{ field: 'secretToken', message: 'Required' }],
        'secretToken',
      );
    }
    if (body.scope.type === 'groups') {
      const missing = body.scope.groupIds.find((id) => !store.groups.getById(id));
      if (missing !== undefined) {
        throw invalidReference(`No group with id '${missing}'.`, 'scope.groupIds');
      }
    }
    const saved = store.provisioning.upsertConfig({
      appId,
      enabled: body.enabled,
      tenantUrl: body.tenantUrl,
      secretToken,
      scope:
        body.scope.type === 'groups'
          ? { type: 'groups', groupIds: [...new Set(body.scope.groupIds)] }
          : { type: 'all' },
      autoSync: body.autoSync,
      patchDialect: body.patchDialect,
      allowInsecureTls: body.allowInsecureTls,
    });
    return configDto(saved);
  });

  app.delete(
    '/api/apps/:id/provisioning',
    (request: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      const appId = request.params.id;
      requireConfig(appId);
      if (provisioning.isRunning(appId)) {
        throw conflict('A provisioning job is running; try again when it finishes.', 'provisioning');
      }
      store.provisioning.deleteConfig(appId);
      void reply.code(204);
      return null;
    },
  );

  app.post(
    '/api/apps/:id/provisioning/test-connection',
    async (request: FastifyRequest<{ Params: IdParams }>) => {
      const appId = request.params.id;
      requireApp(appId);
      const body = provisioningTestSchema.parse(request.body ?? {});
      const saved = store.provisioning.getConfig(appId);
      const tenantUrl = body.tenantUrl ?? saved?.tenantUrl;
      const secretToken = body.secretToken ?? saved?.secretToken;
      if (tenantUrl === undefined || secretToken === undefined) {
        throw validationError(
          'tenantUrl and secretToken are required when provisioning is not configured.',
          [
            ...(tenantUrl === undefined ? [{ field: 'tenantUrl', message: 'Required' }] : []),
            ...(secretToken === undefined ? [{ field: 'secretToken', message: 'Required' }] : []),
          ],
        );
      }
      return provisioning.testConnection(
        {
          tenantUrl,
          secretToken,
          allowInsecureTls: body.allowInsecureTls ?? saved?.allowInsecureTls ?? false,
        },
        appId,
      );
    },
  );

  app.post(
    '/api/apps/:id/provisioning/cycles',
    async (request: FastifyRequest<{ Params: IdParams }>) => {
      const appId = request.params.id;
      requireConfig(appId);
      return toCycleSummaryDto(await runJob(() => provisioning.runCycle(appId, 'manual')));
    },
  );

  app.post(
    '/api/apps/:id/provisioning/restart',
    async (request: FastifyRequest<{ Params: IdParams }>) => {
      const appId = request.params.id;
      requireConfig(appId);
      return toCycleSummaryDto(await runJob(() => provisioning.runCycle(appId, 'restart')));
    },
  );

  app.post(
    '/api/apps/:id/provisioning/on-demand',
    async (request: FastifyRequest<{ Params: IdParams }>) => {
      const appId = request.params.id;
      requireConfig(appId);
      const { userId } = onDemandSchema.parse(request.body);
      if (!store.users.getById(userId)) {
        throw invalidReference(`No user with id '${userId}'.`, 'userId');
      }
      return toCycleSummaryDto(
        await runJob(() => provisioning.provisionOnDemand(appId, userId)),
      );
    },
  );

  app.get(
    '/api/apps/:id/provisioning/objects',
    (request: FastifyRequest<{ Params: IdParams }>) => {
      const appId = request.params.id;
      requireConfig(appId);
      const query = provisioningObjectsQuerySchema.parse(request.query);
      const all = store.provisioning.listObjects(appId, query.type);
      const page = all.slice(query.skip, query.skip + query.top);
      return toPaged(page.map(toProvisionedObjectDto), all.length, query.top, query.skip);
    },
  );

  app.get('/api/apps/:id/provisioning/logs', (request: FastifyRequest<{ Params: IdParams }>) => {
    const appId = request.params.id;
    requireConfig(appId);
    const query = provisioningLogsQuerySchema.parse(request.query);
    const filter = { cycleId: query.cycleId, outcome: query.outcome };
    const value = store.provisioning
      .listLogs(appId, { ...filter, top: query.top, skip: query.skip })
      .map(toProvisioningLogDto);
    return toPaged(value, store.provisioning.countLogs(appId, filter), query.top, query.skip);
  });
}
