import type { FastifyInstance } from 'fastify';
import { adminErrorHandler, adminNotFound } from './errors.js';
import { registerAppRoutes } from './routes.apps.js';
import { registerGroupRoutes } from './routes.groups.js';
import { registerProvisioningRoutes } from './routes.provisioning.js';
import { registerSystemRoutes } from './routes.system.js';
import { registerUserRoutes } from './routes.users.js';

/** Admin paths whose successful writes change the directory (users, groups, membership, seed). */
const DIRECTORY_WRITE_PATH = /^\/admin\/api\/(users|groups|seed)(\/|\?|$)/;

/**
 * Admin REST API (#11), mounted under `/admin`. An encapsulated plugin with its own error handler
 * (the canonical admin error envelope) and not-found handler (JSON, never the SPA HTML). The real
 * CRUD routes live under `/admin/api/*`; any other `/admin/*` path returns a JSON 404.
 *
 * Unauthenticated by design (locked decision: open local dev tool, documented security disclaimer).
 */
export async function registerAdminApi(app: FastifyInstance): Promise<void> {
  await app.register(
    (admin, _opts, done) => {
      admin.setErrorHandler(adminErrorHandler);
      admin.setNotFoundHandler(adminNotFound);

      // SCIM auto-sync: any successful user/group write (incl. membership and seed) schedules a
      // debounced provisioning cycle for apps with `autoSync` enabled.
      admin.addHook('onResponse', (request, reply, hookDone) => {
        if (
          request.method !== 'GET' &&
          reply.statusCode < 300 &&
          DIRECTORY_WRITE_PATH.test(request.url)
        ) {
          app.provisioning.notifyDirectoryChanged();
        }
        hookDone();
      });

      registerUserRoutes(admin);
      registerGroupRoutes(admin);
      registerAppRoutes(admin);
      registerProvisioningRoutes(admin);
      registerSystemRoutes(admin);

      done();
    },
    { prefix: '/admin' },
  );
}
