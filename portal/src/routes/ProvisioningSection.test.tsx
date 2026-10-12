import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvisioningSection } from './ProvisioningSection';
import type { CycleSummary, ProvisioningConfig, ProvisioningLog } from '../api/types';
import { installFetch, paged, type RequestContext, type RouteResult } from '../test/server';
import { expectNoCriticalAxe, renderWithProviders } from '../test/utils';

const APP_ID = 'cccccccc-0000-0000-0000-000000000001';
const BASE = `/admin/api/apps/${APP_ID}/provisioning`;

const CYCLE: CycleSummary = {
  id: 'cyc-1',
  trigger: 'manual',
  startedAt: '2026-10-12T10:00:00.000Z',
  finishedAt: '2026-10-12T10:00:02.000Z',
  outcome: 'partial',
  counts: { created: 2, updated: 1, disabled: 0, deleted: 0, skipped: 0, failed: 1 },
};

function config(over: Partial<ProvisioningConfig> = {}): ProvisioningConfig {
  return {
    appId: APP_ID,
    enabled: true,
    tenantUrl: 'https://localhost:5001/scim/v2',
    hasSecretToken: true,
    scope: { type: 'all' },
    autoSync: false,
    patchDialect: 'compliant',
    allowInsecureTls: false,
    lastCycle: CYCLE,
    inFlight: false,
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    ...over,
  };
}

const LOG: ProvisioningLog = {
  id: 'log-1',
  cycleId: 'cyc-1',
  at: '2026-10-12T10:00:01.000Z',
  objectType: 'user',
  sourceId: 'u-alice',
  action: 'create',
  method: 'POST',
  url: 'https://localhost:5001/scim/v2/Users',
  statusCode: 201,
  outcome: 'success',
  errorMessage: null,
  requestBody: '{"userName":"alice@entralocal.dev","active":true}',
  responseBody: '{"id":"scim-123"}',
};

const ALICE = {
  id: 'u-alice',
  userPrincipalName: 'alice@entralocal.dev',
  displayName: 'Alice Example',
  givenName: 'Alice',
  surname: 'Example',
  mail: 'alice@entralocal.dev',
  accountEnabled: true,
  hasPassword: true,
  createdAt: '2026-06-22T00:00:00.000Z',
};

const GROUP = {
  id: 'g-eng',
  displayName: 'Engineering',
  description: null,
  memberCount: 3,
  createdAt: '2026-06-22T00:00:00.000Z',
};

type Calls = RequestContext[];

/** Install a fake admin API; `initial` null = not configured (404). Records every request. */
function setup(
  initial: ProvisioningConfig | null,
  extra: (ctx: RequestContext) => RouteResult | undefined = () => undefined,
): Calls {
  const calls: Calls = [];
  let current = initial;
  installFetch((ctx) => {
    const { method, path, body } = ctx;
    if (path.startsWith('/admin/api/')) calls.push(ctx);
    const custom = extra(ctx);
    if (custom) return custom;
    if (method === 'GET' && path === BASE) {
      return current
        ? { body: current }
        : { status: 404, body: { error: { code: 'not_found', message: 'Not configured.' } } };
    }
    if (method === 'PUT' && path === BASE) {
      const b = body as Omit<ProvisioningConfig, 'hasSecretToken'> & { secretToken?: string };
      const { secretToken, ...rest } = b;
      current = config({
        ...rest,
        hasSecretToken: Boolean(secretToken) || (current?.hasSecretToken ?? false),
        lastCycle: current?.lastCycle ?? null,
      });
      return { body: current };
    }
    if (method === 'DELETE' && path === BASE) {
      current = null;
      return { status: 204 };
    }
    if (method === 'GET' && path.startsWith(`${BASE}/logs`)) return paged([LOG], 20);
    if (method === 'GET' && path.startsWith('/admin/api/groups')) return paged([GROUP], 100);
    if (method === 'GET' && path.startsWith('/admin/api/users')) return paged([ALICE], 100);
    if (method === 'POST' && path === `${BASE}/test-connection`) {
      return { body: { ok: true, statusCode: 200, message: 'ServiceProviderConfig reachable.' } };
    }
    if (method === 'POST' && path === `${BASE}/cycles`) return { body: CYCLE };
    if (method === 'POST' && path === `${BASE}/restart`)
      return { body: { ...CYCLE, trigger: 'restart' } };
    if (method === 'POST' && path === `${BASE}/on-demand`) {
      return { body: { ...CYCLE, trigger: 'on-demand' } };
    }
    return undefined;
  });
  return calls;
}

function render(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(<ProvisioningSection appId={APP_ID} />);
}

function find(calls: Calls, method: string, path: string): RequestContext[] {
  return calls.filter((c) => c.method === method && c.path === path);
}

describe('ProvisioningSection — config form', () => {
  it('renders an empty form when provisioning is not configured (404)', async () => {
    setup(null);
    const { container } = render();

    expect(await screen.findByText(/isn't configured for this app yet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Tenant URL')).toHaveValue('');
    expect(screen.getByLabelText('Secret token')).toHaveValue('');
    expect(screen.getByLabelText('Secret token')).not.toHaveAttribute(
      'placeholder',
      '•••••• saved',
    );
    expect(screen.getByRole('switch', { name: 'Enable provisioning' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('radio', { name: 'All users and groups' })).toBeChecked();
    // Actions and log only appear once a config exists.
    expect(screen.queryByRole('button', { name: 'Provision now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove provisioning' })).not.toBeInTheDocument();
    await expectNoCriticalAxe(container);
  });

  it('requires a secret token the first time and sends it in the PUT', async () => {
    const calls = setup(null);
    render();

    await userEvent.type(await screen.findByLabelText('Tenant URL'), 'https://scim.test/v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Secret token is required/)).toBeInTheDocument();
    expect(find(calls, 'PUT', BASE)).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Secret token'), 's3cr3t');
    await userEvent.click(screen.getByRole('radio', { name: 'Selected groups' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Engineering/ }));
    await userEvent.selectOptions(screen.getByLabelText('PATCH dialect'), 'legacy');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(find(calls, 'PUT', BASE)).toHaveLength(1));
    expect(find(calls, 'PUT', BASE)[0]!.body).toEqual({
      enabled: false,
      tenantUrl: 'https://scim.test/v2',
      secretToken: 's3cr3t',
      scope: { type: 'groups', groupIds: ['g-eng'] },
      autoSync: false,
      patchDialect: 'legacy',
      allowInsecureTls: false,
    });
    // After saving, the token field is cleared and shows the saved placeholder.
    await waitFor(() =>
      expect(screen.getByLabelText('Secret token')).toHaveAttribute('placeholder', '•••••• saved'),
    );
    expect(screen.getByLabelText('Secret token')).toHaveValue('');
  });

  it('keeps the secret write-only: never populated, omitted from PUT unless typed', async () => {
    const calls = setup(config());
    render();

    const secret = await screen.findByLabelText('Secret token');
    await waitFor(() =>
      expect(screen.getByLabelText('Tenant URL')).toHaveValue(config().tenantUrl),
    );
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('placeholder', '•••••• saved');

    await userEvent.click(screen.getByRole('switch', { name: 'Auto-sync' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(find(calls, 'PUT', BASE)).toHaveLength(1));
    const first = find(calls, 'PUT', BASE)[0]!.body as Record<string, unknown>;
    expect(first).not.toHaveProperty('secretToken');
    expect(first.autoSync).toBe(true);

    await userEvent.type(screen.getByLabelText('Secret token'), 'rotated');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(find(calls, 'PUT', BASE)).toHaveLength(2));
    expect(find(calls, 'PUT', BASE)[1]!.body).toMatchObject({ secretToken: 'rotated' });
  });

  it('tests the connection with unsaved values and shows the result', async () => {
    const calls = setup(config());
    render();

    const url = await screen.findByLabelText('Tenant URL');
    await waitFor(() => expect(url).toHaveValue(config().tenantUrl));
    await userEvent.clear(url);
    await userEvent.type(url, 'https://other.test/scim');
    await userEvent.type(screen.getByLabelText('Secret token'), 'unsaved');
    await userEvent.click(screen.getByRole('switch', { name: 'Allow insecure TLS' }));
    expect(screen.getByText(/TLS certificate checks are off/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Connection succeeded.')).toBeInTheDocument();
    expect(screen.getByText(/ServiceProviderConfig reachable/)).toBeInTheDocument();
    expect(find(calls, 'POST', `${BASE}/test-connection`)[0]!.body).toEqual({
      tenantUrl: 'https://other.test/scim',
      secretToken: 'unsaved',
      allowInsecureTls: true,
    });
    // Testing doesn't save.
    expect(find(calls, 'PUT', BASE)).toHaveLength(0);
  });

  it('removes provisioning after confirming', async () => {
    const calls = setup(config());
    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove provisioning' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove provisioning' }));

    await waitFor(() => expect(find(calls, 'DELETE', BASE)).toHaveLength(1));
    expect(await screen.findByText(/isn't configured for this app yet/)).toBeInTheDocument();
  });
});

describe('ProvisioningSection — actions', () => {
  it('shows the last-cycle summary and runs Provision now', async () => {
    const calls = setup(config());
    const { container } = render();

    const summary = await screen.findByTestId('last-cycle');
    expect(summary).toHaveTextContent('Manual');
    expect(summary).toHaveTextContent('partial');
    expect(summary).toHaveTextContent('created 2');
    expect(summary).toHaveTextContent('failed 1');
    expect(summary).toHaveTextContent('2026-10-12 10:00:02');

    const getsBefore = find(calls, 'GET', BASE).length;
    await userEvent.click(screen.getByRole('button', { name: 'Provision now' }));
    await waitFor(() => expect(find(calls, 'POST', `${BASE}/cycles`)).toHaveLength(1));
    // The config (and last cycle) is refreshed after the action.
    await waitFor(() => expect(find(calls, 'GET', BASE).length).toBeGreaterThan(getsBefore));
    await expectNoCriticalAxe(container);
  });

  it('shows a 409 conflict as an error banner', async () => {
    setup(config({ enabled: false }), ({ method, path }) =>
      method === 'POST' && path === `${BASE}/cycles`
        ? {
            status: 409,
            body: {
              error: {
                code: 'conflict',
                message: 'Provisioning is disabled',
                target: 'provisioning',
              },
            },
          }
        : undefined,
    );
    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Provision now' }));
    expect(await screen.findByText('Provisioning is disabled')).toBeInTheDocument();
  });

  it('restarts after confirming', async () => {
    const calls = setup(config());
    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart provisioning?' });
    expect(find(calls, 'POST', `${BASE}/restart`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(find(calls, 'POST', `${BASE}/restart`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('provisions a selected user on demand', async () => {
    const calls = setup(config());
    render();

    const picker = await screen.findByLabelText('Provision on demand');
    await screen.findByRole('option', { name: /Alice Example/ });
    expect(screen.getByRole('button', { name: 'Provision user' })).toBeDisabled();
    await userEvent.selectOptions(picker, 'u-alice');
    await userEvent.click(screen.getByRole('button', { name: 'Provision user' }));

    await waitFor(() => expect(find(calls, 'POST', `${BASE}/on-demand`)).toHaveLength(1));
    expect(find(calls, 'POST', `${BASE}/on-demand`)[0]!.body).toEqual({ userId: 'u-alice' });
  });
});

describe('ProvisioningSection — log', () => {
  it('lists log entries and opens a drawer with pretty-printed bodies', async () => {
    setup(config());
    render();

    const time = await screen.findByRole('button', { name: '2026-10-12 10:00:01' });
    const row = time.closest('tr')!;
    expect(within(row).getByText('create')).toBeInTheDocument();
    expect(within(row).getByText('201')).toBeInTheDocument();
    expect(within(row).getByText('success')).toBeInTheDocument();

    await userEvent.click(within(row).getByText('POST'));
    const drawer = await screen.findByRole('dialog', { name: 'Log entry' });
    expect(within(drawer).getByTestId('log-url')).toHaveTextContent(
      'https://localhost:5001/scim/v2/Users',
    );
    const request = within(drawer).getByTestId('log-request-body');
    expect(request.textContent).toContain('"userName": "alice@entralocal.dev"');
    expect(within(drawer).getByTestId('log-response-body').textContent).toContain(
      '"id": "scim-123"',
    );

    await userEvent.click(within(drawer).getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Log entry' })).not.toBeInTheDocument(),
    );
  });
});
