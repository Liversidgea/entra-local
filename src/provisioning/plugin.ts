import type { FastifyInstance } from 'fastify';
import { createProvisioningEngine, type ProvisioningEngine } from './engine.js';

/** Debounce window for auto-sync after an admin directory change (spec: 2 s). */
export const AUTO_SYNC_DEBOUNCE_MS = 2000;

export interface ProvisioningService extends ProvisioningEngine {
  /**
   * Signal that the directory changed through the admin API. For every app with provisioning
   * `enabled && autoSync`, (re)start a debounce timer; when it fires an `auto` cycle runs. If a job
   * is already running when the timer fires, the cycle is re-scheduled rather than queued.
   */
  notifyDirectoryChanged(): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** SCIM outbound provisioning (Entra provisioning-service emulation). */
    provisioning: ProvisioningService;
  }
}

/** Decorate `app.provisioning` and clear pending auto-sync timers on close. */
export function registerProvisioning(app: FastifyInstance): void {
  const engine = createProvisioningEngine(app.store);
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  async function autoCycle(appId: string): Promise<void> {
    timers.delete(appId);
    if (closed) return;
    const config = app.store.provisioning.getConfig(appId);
    if (!config?.enabled || !config.autoSync) return;
    if (engine.isRunning(appId)) {
      schedule(appId);
      return;
    }
    try {
      await engine.runCycle(appId, 'auto');
    } catch (err) {
      app.log.warn({ err, appId }, 'Auto-sync provisioning cycle failed');
    }
  }

  function schedule(appId: string): void {
    const existing = timers.get(appId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void autoCycle(appId), AUTO_SYNC_DEBOUNCE_MS);
    timer.unref();
    timers.set(appId, timer);
  }

  const service: ProvisioningService = {
    ...engine,
    notifyDirectoryChanged() {
      if (closed) return;
      for (const config of app.store.provisioning.listConfigs()) {
        if (config.enabled && config.autoSync) schedule(config.appId);
      }
    },
  };

  app.decorate('provisioning', service);
  app.addHook('onClose', () => {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });
}
