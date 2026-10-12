import { useCallback, useEffect, useId, useState } from 'react';
import { api, ApiError } from '../api/client';
import type {
  CycleOutcome,
  CycleSummary,
  Group,
  PatchDialect,
  ProvisioningConfig,
  ProvisioningLog,
  ProvisioningLogOutcome,
  TestConnectionResult,
  User,
} from '../api/types';
import { useAsync } from '../hooks/useAsync';
import { useShell } from '../hooks/useToast';
import type { Line } from '../lib/msalSnippet';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { CodeBlock } from '../components/CodeBlock';
import { ConfirmDialog } from '../components/Dialog';
import { Drawer } from '../components/Drawer';
import { Field, Select, TextInput, Toggle } from '../components/Fields';
import { IdChip } from '../components/IdChip';
import { Pagination } from '../components/Pagination';
import { SkeletonRows } from '../components/States';
import { StatusDot } from '../components/StatusDot';

const LOG_PAGE_SIZE = 20;

/**
 * SCIM outbound provisioning for one app registration: the write-only config form, the
 * test/provision/restart/on-demand actions, the last-cycle summary and the paged SCIM log.
 * `GET .../provisioning` returning `404 not_found` means "not configured yet" (empty form).
 */
export function ProvisioningSection({ appId }: { appId: string }): JSX.Element {
  // undefined = first load in progress; null = not configured (404).
  const [config, setConfig] = useState<ProvisioningConfig | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // Bumped when the saved config is replaced (save / remove) so the form re-initializes.
  const [formVersion, setFormVersion] = useState(0);
  // Bumped after any action so the log table re-fetches.
  const [logVersion, setLogVersion] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setConfig(await api.getProvisioning(appId));
      setLoadError(undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setConfig(null);
        setLoadError(undefined);
      } else {
        setLoadError(err instanceof ApiError ? err.message : 'Unexpected error.');
      }
    }
  }, [appId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadError && config === undefined) {
    return (
      <Banner tone="error" role="alert">
        <strong>Couldn't load provisioning.</strong> {loadError}{' '}
        <button type="button" className="link" onClick={() => void refresh()}>
          Retry
        </button>
      </Banner>
    );
  }

  if (config === undefined) {
    return (
      <section className="card" aria-busy="true">
        <h2 className="h-md mb16">Provisioning</h2>
        <table className="dt">
          <tbody>
            <SkeletonRows rows={4} cols={2} />
          </tbody>
        </table>
      </section>
    );
  }

  return (
    <>
      <ConfigCard
        key={formVersion}
        appId={appId}
        config={config}
        onSaved={(next) => {
          setConfig(next);
          setFormVersion((v) => v + 1);
        }}
        onRemoved={() => {
          setConfig(null);
          setFormVersion((v) => v + 1);
          setLogVersion((v) => v + 1);
        }}
      />
      {config && (
        <>
          <ActionsCard
            appId={appId}
            config={config}
            onRan={() => {
              void refresh();
              setLogVersion((v) => v + 1);
            }}
          />
          <LogCard appId={appId} version={logVersion} />
        </>
      )}
    </>
  );
}

// --- Config form ---------------------------------------------------------------------------------

const DIALECTS: { value: PatchDialect; label: string }[] = [
  { value: 'compliant', label: 'Compliant (default)' },
  { value: 'legacy', label: 'Legacy (pre-2020 Entra)' },
];

interface ConfigCardProps {
  appId: string;
  config: ProvisioningConfig | null;
  onSaved: (next: ProvisioningConfig) => void;
  onRemoved: () => void;
}

function ConfigCard({ appId, config, onSaved, onRemoved }: ConfigCardProps): JSX.Element {
  const { toast } = useShell();
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [tenantUrl, setTenantUrl] = useState(config?.tenantUrl ?? '');
  // Write-only: never pre-filled from the server, only sent when the user types one.
  const [secretToken, setSecretToken] = useState('');
  const [scopeType, setScopeType] = useState<'all' | 'groups'>(config?.scope.type ?? 'all');
  const [groupIds, setGroupIds] = useState<string[]>(
    config?.scope.type === 'groups' ? config.scope.groupIds : [],
  );
  const [autoSync, setAutoSync] = useState(config?.autoSync ?? false);
  const [patchDialect, setPatchDialect] = useState<PatchDialect>(
    config?.patchDialect ?? 'compliant',
  );
  const [allowInsecureTls, setAllowInsecureTls] = useState(config?.allowInsecureTls ?? false);

  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const scopeName = useId();
  const { data: groups } = useAsync(() => api.listGroups({ top: 100 }), []);
  const groupList: Group[] = groups?.value ?? [];

  function toggleGroup(id: string, on: boolean): void {
    setGroupIds((prev) => (on ? [...prev, id] : prev.filter((g) => g !== id)));
  }

  async function save(): Promise<void> {
    const local: Partial<Record<string, string>> = {};
    if (!tenantUrl.trim()) local.tenantUrl = 'Tenant URL is required.';
    if (!config?.hasSecretToken && !secretToken) {
      local.secretToken = 'Secret token is required the first time you save.';
    }
    setErrors(local);
    setFormError(undefined);
    if (Object.keys(local).length > 0) return;

    setSaving(true);
    try {
      const next = await api.saveProvisioning(appId, {
        enabled,
        tenantUrl: tenantUrl.trim(),
        ...(secretToken ? { secretToken } : {}),
        scope: scopeType === 'all' ? { type: 'all' } : { type: 'groups', groupIds },
        autoSync,
        patchDialect,
        allowInsecureTls,
      });
      toast('Provisioning configuration saved.');
      onSaved(next);
    } catch (err) {
      if (err instanceof ApiError) {
        const map: Partial<Record<string, string>> = {};
        for (const d of err.details) map[d.field] = d.message;
        if (Object.keys(map).length === 0 && err.target) map[err.target] = err.message;
        setErrors(map);
        setFormError(err.message);
      } else {
        setFormError('Unexpected error.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(): Promise<void> {
    setTesting(true);
    setTestResult(undefined);
    try {
      setTestResult(
        await api.testProvisioningConnection(appId, {
          ...(tenantUrl.trim() ? { tenantUrl: tenantUrl.trim() } : {}),
          ...(secretToken ? { secretToken } : {}),
          allowInsecureTls,
        }),
      );
    } catch (err) {
      setTestResult({
        ok: false,
        statusCode: null,
        message: err instanceof ApiError ? err.message : 'Unexpected error.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function remove(): Promise<void> {
    setRemoving(true);
    try {
      await api.deleteProvisioning(appId);
      toast('Provisioning removed.');
      setConfirmRemove(false);
      onRemoved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't remove provisioning.", 'bad');
      setRemoving(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head-flush">
        <div>
          <h2 className="h-md">Provisioning</h2>
          <p className="b-sm muted" style={{ marginTop: 2 }}>
            Push users and groups from this local emulator to a SCIM 2.0 server.
          </p>
        </div>
        <Button variant="primary" onClick={() => void save()} busy={saving}>
          Save
        </Button>
      </div>

      {!config && (
        <p className="b-sm muted" style={{ margin: '0 0 16px' }}>
          Provisioning isn't configured for this app yet. Enter the target's SCIM base URL and
          bearer token, then save.
        </p>
      )}

      <div className="field">
        <Toggle checked={enabled} onChange={setEnabled} label="Enable provisioning" />
        <div className="help">
          When off, Provision now, Restart and auto-sync are refused. On-demand provisioning and
          Test connection still work.
        </div>
      </div>

      <Field
        label="Tenant URL"
        htmlFor="prov-tenant-url"
        error={errors.tenantUrl}
        help={
          <>
            SCIM base URL, e.g. <span className="mono">https://localhost:5001/scim/v2</span>.
          </>
        }
      >
        <TextInput
          id="prov-tenant-url"
          mono
          type="url"
          value={tenantUrl}
          invalid={!!errors.tenantUrl}
          onChange={(e) => setTenantUrl(e.target.value)}
          placeholder="https://localhost:5001/scim/v2"
        />
      </Field>

      <Field
        label="Secret token"
        htmlFor="prov-secret"
        error={errors.secretToken}
        help={
          config?.hasSecretToken
            ? 'A token is saved. Leave blank to keep it, or type a new one to replace it.'
            : 'Sent as a bearer token. Write-only: it is never shown again after you save.'
        }
      >
        <TextInput
          id="prov-secret"
          type="password"
          autoComplete="new-password"
          value={secretToken}
          invalid={!!errors.secretToken}
          onChange={(e) => setSecretToken(e.target.value)}
          placeholder={config?.hasSecretToken ? '•••••• saved' : ''}
        />
      </Field>

      <fieldset className="field" style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
        <legend style={{ padding: 0, marginBottom: 4, fontWeight: 600 }}>Scope</legend>
        <label className="picker-row clickable" style={{ padding: '4px 0' }}>
          <input
            type="radio"
            name={scopeName}
            value="all"
            checked={scopeType === 'all'}
            onChange={() => setScopeType('all')}
          />
          All users and groups
        </label>
        <label className="picker-row clickable" style={{ padding: '4px 0' }}>
          <input
            type="radio"
            name={scopeName}
            value="groups"
            checked={scopeType === 'groups'}
            onChange={() => setScopeType('groups')}
          />
          Selected groups
        </label>
        {errors.scope && <div className="field-error">{errors.scope}</div>}
      </fieldset>

      {scopeType === 'groups' && (
        <fieldset className="field" style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
          <legend style={{ padding: 0, marginBottom: 4, fontWeight: 600 }}>Groups in scope</legend>
          <div className="help" style={{ marginTop: 0, marginBottom: 8 }}>
            The selected groups and their direct members are provisioned.
          </div>
          <div className="picker-list">
            {groupList.length === 0 && (
              <div className="picker-row muted b-sm">No groups in the directory yet.</div>
            )}
            {groupList.map((g) => (
              <label className="picker-row clickable" key={g.id}>
                <input
                  type="checkbox"
                  checked={groupIds.includes(g.id)}
                  onChange={(e) => toggleGroup(g.id, e.target.checked)}
                />
                <span style={{ flex: 1 }}>{g.displayName}</span>
                <span className="b-sm muted">
                  {g.memberCount} member{g.memberCount === 1 ? '' : 's'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="field">
        <Toggle checked={autoSync} onChange={setAutoSync} label="Auto-sync" />
        <div className="help">
          Run a cycle about 2 seconds after users or groups change through the admin API.
        </div>
      </div>

      <Field
        label="PATCH dialect"
        htmlFor="prov-dialect"
        help="Legacy matches pre-2020 Entra group-membership PATCH requests."
      >
        <Select
          id="prov-dialect"
          style={{ width: 260 }}
          value={patchDialect}
          onChange={(e) => setPatchDialect(e.target.value as PatchDialect)}
        >
          {DIALECTS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="field">
        <Toggle
          checked={allowInsecureTls}
          onChange={setAllowInsecureTls}
          label="Allow insecure TLS"
        />
        <div className="help">Skip certificate verification for this target only.</div>
      </div>
      {allowInsecureTls && (
        <Banner tone="caution" className="mb16">
          TLS certificate checks are off for this target. Use this only for local SCIM servers with
          self-signed certificates.
        </Banner>
      )}

      {formError && (
        <Banner tone="error" role="alert" className="mb16">
          {formError}
        </Banner>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={() => void testConnection()} busy={testing}>
          Test connection
        </Button>
        {config && (
          <Button variant="destructive" onClick={() => setConfirmRemove(true)}>
            Remove provisioning
          </Button>
        )}
      </div>

      {testResult && (
        <Banner
          tone={testResult.ok ? 'success' : 'error'}
          role={testResult.ok ? 'status' : 'alert'}
          className="mt12"
        >
          <strong>{testResult.ok ? 'Connection succeeded.' : 'Connection failed.'}</strong>{' '}
          {testResult.statusCode !== null && (
            <span className="mono">HTTP {testResult.statusCode}. </span>
          )}
          {testResult.message}
        </Banner>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove provisioning?"
          confirmLabel="Remove provisioning"
          destructive
          busy={removing}
          onConfirm={() => void remove()}
          onClose={() => setConfirmRemove(false)}
        >
          <p>
            Remove this app's provisioning config, mapped-object state and logs? No SCIM calls are
            sent, so objects already created on the target stay there.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

// --- Actions + last cycle ------------------------------------------------------------------------

type RunningAction = 'cycle' | 'restart' | 'on-demand';

const CYCLE_TONE: Record<CycleOutcome, 'ok' | 'warn' | 'bad'> = {
  success: 'ok',
  partial: 'warn',
  failed: 'bad',
};

const TRIGGER_LABEL: Record<CycleSummary['trigger'], string> = {
  manual: 'Manual',
  restart: 'Restart',
  'on-demand': 'On demand',
  auto: 'Auto-sync',
};

interface ActionsCardProps {
  appId: string;
  config: ProvisioningConfig;
  onRan: () => void;
}

function ActionsCard({ appId, config, onRan }: ActionsCardProps): JSX.Element {
  const { toast } = useShell();
  const [running, setRunning] = useState<RunningAction | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [userId, setUserId] = useState('');

  const { data: users } = useAsync(() => api.listUsers({ top: 100 }), []);
  const userList: User[] = users?.value ?? [];

  async function run(kind: RunningAction, call: () => Promise<CycleSummary>): Promise<void> {
    setRunning(kind);
    setError(undefined);
    try {
      const summary = await call();
      toast(`Provisioning cycle finished: ${summary.outcome ?? 'running'}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error.');
    } finally {
      setRunning(null);
      setConfirmRestart(false);
      onRan();
    }
  }

  const disabled = running !== null;
  const last = config.lastCycle;

  return (
    <section className="card">
      <div className="card-head-flush">
        <h2 className="h-md">Provisioning actions</h2>
      </div>

      {!config.enabled && (
        <Banner tone="caution" className="mb16">
          Provisioning is disabled. Provision now and Restart are refused until you enable and save
          it. On-demand provisioning still works.
        </Banner>
      )}
      {config.inFlight && running === null && (
        <Banner tone="caution" className="mb16">
          A provisioning cycle is running. New cycles are refused until it finishes.
        </Banner>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          onClick={() => void run('cycle', () => api.runProvisioningCycle(appId))}
          busy={running === 'cycle'}
          disabled={disabled}
        >
          Provision now
        </Button>
        <Button onClick={() => setConfirmRestart(true)} disabled={disabled}>
          Restart
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ margin: '16px 0 0' }}>
          <label htmlFor="prov-on-demand-user">Provision on demand</label>
          <Select
            id="prov-on-demand-user"
            value={userId}
            style={{ width: 280 }}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Select a user…</option>
            {userList.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.userPrincipalName})
              </option>
            ))}
          </Select>
        </div>
        <Button
          onClick={() => void run('on-demand', () => api.provisionOnDemand(appId, userId))}
          busy={running === 'on-demand'}
          disabled={disabled || !userId}
        >
          Provision user
        </Button>
      </div>

      {error && (
        <Banner tone="error" role="alert" className="mt12">
          {error}
        </Banner>
      )}

      <h3 className="h-sm" style={{ margin: '20px 0 8px' }}>
        Last cycle
      </h3>
      {last ? (
        <div className="kv" data-testid="last-cycle">
          <span className="k">Trigger</span>
          <span>{TRIGGER_LABEL[last.trigger]}</span>
          <span className="k">Outcome</span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {last.outcome ? (
              <>
                <StatusDot tone={CYCLE_TONE[last.outcome]} />
                {last.outcome}
              </>
            ) : (
              <>
                <StatusDot tone="warn" />
                running
              </>
            )}
          </span>
          <span className="k">Counts</span>
          <span>
            {last.counts
              ? (Object.entries(last.counts) as [string, number][]).map(([k, n]) => (
                  <span className="chip-plain" key={k}>
                    {k} {n}
                  </span>
                ))
              : '—'}
          </span>
          <span className="k">Finished</span>
          <span className="mono b-sm">{formatTime(last.finishedAt)}</span>
        </div>
      ) : (
        <p className="b-sm muted">No cycles have run yet.</p>
      )}

      {confirmRestart && (
        <ConfirmDialog
          title="Restart provisioning?"
          confirmLabel="Restart"
          busy={running === 'restart'}
          onConfirm={() => void run('restart', () => api.restartProvisioning(appId))}
          onClose={() => setConfirmRestart(false)}
        >
          <p>
            Clear this app's mapped-object state and run a full cycle? Every user and group is
            re-matched on the target by query.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

// --- Log ----------------------------------------------------------------------------------------

const LOG_TONE: Record<ProvisioningLogOutcome, 'ok' | 'warn' | 'bad'> = {
  success: 'ok',
  skipped: 'warn',
  failure: 'bad',
};

function LogCard({ appId, version }: { appId: string; version: number }): JSX.Element {
  const [skip, setSkip] = useState(0);
  const [selected, setSelected] = useState<ProvisioningLog | null>(null);
  const { data, loading, error, reload } = useAsync(
    () => api.listProvisioningLogs(appId, { top: LOG_PAGE_SIZE, skip }),
    [appId, skip, version],
  );
  const rows = data?.value ?? [];

  return (
    <section className="card flush">
      <div className="card-head">
        <h2 className="h-md">Provisioning log</h2>
        <Button size="sm" onClick={reload}>
          Refresh
        </Button>
      </div>
      {error && (
        <div style={{ padding: 16 }}>
          <Banner tone="error" role="alert">
            {error.message}
          </Banner>
        </div>
      )}
      <table className="dt" aria-busy={loading || undefined}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Object</th>
            <th>Method</th>
            <th>Status</th>
            <th>Outcome</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {loading && !data ? (
            <SkeletonRows rows={3} cols={7} />
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted b-sm">
                No log entries yet. Run a cycle to see SCIM requests here.
              </td>
            </tr>
          ) : (
            rows.map((log) => (
              <tr key={log.id} onClick={() => setSelected(log)} style={{ cursor: 'pointer' }}>
                <td className="b-sm">
                  <button
                    type="button"
                    className="link mono"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(log);
                    }}
                  >
                    {formatTime(log.at)}
                  </button>
                </td>
                <td>
                  <span className="chip-plain">{log.action}</span>
                </td>
                <td>{log.objectType ?? '—'}</td>
                <td className="mono b-sm">{log.method}</td>
                <td className="mono b-sm">{log.statusCode ?? '—'}</td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <StatusDot tone={LOG_TONE[log.outcome]} />
                    {log.outcome}
                  </span>
                </td>
                <td className="b-sm" style={{ maxWidth: 260 }}>
                  {log.errorMessage ?? '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {data && data.count > 0 && (
        <Pagination
          skip={skip}
          top={LOG_PAGE_SIZE}
          count={data.count}
          onPrev={() => setSkip((s) => Math.max(0, s - LOG_PAGE_SIZE))}
          onNext={() => setSkip((s) => s + LOG_PAGE_SIZE)}
        />
      )}
      {selected && <LogDrawer log={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function LogDrawer({ log, onClose }: { log: ProvisioningLog; onClose: () => void }): JSX.Element {
  return (
    <Drawer
      wide
      title="Log entry"
      subtitle={`${log.method} · ${log.action} · ${formatTime(log.at)}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="kv mb16">
        <span className="k">Outcome</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <StatusDot tone={LOG_TONE[log.outcome]} />
          {log.outcome}
        </span>
        <span className="k">Status</span>
        <span className="mono b-sm">{log.statusCode ?? '—'}</span>
        <span className="k">Object</span>
        <span>{log.objectType ?? '—'}</span>
        {log.sourceId && (
          <>
            <span className="k">Source ID</span>
            <span>
              <IdChip value={log.sourceId} title="Source object ID" />
            </span>
          </>
        )}
        {log.errorMessage && (
          <>
            <span className="k">Error</span>
            <span className="b-sm">{log.errorMessage}</span>
          </>
        )}
      </div>
      <div className="field">
        <span className="lbl-caps">URL</span>
        <div className="mono b-sm" style={{ wordBreak: 'break-all' }} data-testid="log-url">
          <span className="mono">{log.method}</span> {log.url}
        </div>
      </div>
      <BodyBlock label="Request body" body={log.requestBody} testId="log-request-body" />
      <BodyBlock label="Response body" body={log.responseBody} testId="log-response-body" />
    </Drawer>
  );
}

function BodyBlock({
  label,
  body,
  testId,
}: {
  label: string;
  body: string | null;
  testId: string;
}): JSX.Element {
  return (
    <div className="field">
      <span className="lbl-caps">{label}</span>
      {body ? (
        <CodeBlock
          lines={bodyLines(body)}
          ariaLabel={label}
          copyAnnouncement={`Copied ${label.toLowerCase()}`}
          data-testid={testId}
        />
      ) : (
        <p className="b-sm muted">No body.</p>
      )}
    </div>
  );
}

/** Pretty-print a JSON body when parseable; otherwise show it verbatim. */
function bodyLines(body: string): Line[] {
  let text = body;
  try {
    text = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // not JSON — show as-is
  }
  return text.split('\n').map((t) => [{ t }]);
}

/** ISO timestamp → `YYYY-MM-DD HH:MM:SS` (UTC), or "—". */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 19);
}
