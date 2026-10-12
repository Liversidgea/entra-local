import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import selfsigned from 'selfsigned';

/**
 * In-process SCIM 2.0 test double for the outbound-provisioning suites. Keeps Users/Groups in
 * memory, supports `eq` filters on `userName` / `displayName`, POST, PATCH (applying both the
 * compliant and legacy Entra dialects), and DELETE. Records every request and can be scripted to
 * fail specific calls.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  /** Decoded `filter` query parameter, when present. */
  filter: string | null;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
  contentType: string | undefined;
}

export type Resource = Record<string, unknown> & { id: string };

/** Return a status code to force a failure for this request, or `undefined` to handle it. */
export type FailureRule = (req: RecordedRequest) => number | 'hang' | undefined;

export interface ScimTarget {
  url: string;
  token: string;
  requests: RecordedRequest[];
  users: Map<string, Resource>;
  groups: Map<string, Resource>;
  /** Requests that change state (POST/PATCH/DELETE). */
  writes(): RecordedRequest[];
  failWhen(rule: FailureRule): void;
  clearRules(): void;
  /** Pre-seed a resource as if created by another client. */
  seedUser(resource: Omit<Resource, 'id'>): Resource;
  seedGroup(resource: Omit<Resource, 'id'>): Resource;
  memberIds(groupId: string): string[];
  close(): Promise<void>;
}

const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

function scimError(status: number, detail: string) {
  return { schemas: [ERROR_SCHEMA], status: String(status), detail };
}

/** Parse `attr eq "value"` (only the shape Entra sends). */
function parseEqFilter(filter: string): { attr: string; value: string } | undefined {
  const m = /^(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i.exec(filter.trim());
  if (!m) return undefined;
  return { attr: m[1]!, value: m[2]!.replace(/\\(.)/g, '$1') };
}

function toBool(value: unknown): unknown {
  if (value === 'True' || value === 'true') return true;
  if (value === 'False' || value === 'false') return false;
  return value;
}

function setPath(resource: Resource, path: string, value: unknown): void {
  if (path === 'emails[type eq "work"].value') {
    if (value == null) {
      delete resource.emails;
      return;
    }
    resource.emails = [{ value, type: 'work', primary: true }];
    return;
  }
  const parts = path.split('.');
  if (parts.length === 2) {
    const parent = (resource[parts[0]!] ?? {}) as Record<string, unknown>;
    if (value == null) delete parent[parts[1]!];
    else parent[parts[1]!] = value;
    resource[parts[0]!] = parent;
    return;
  }
  if (value == null) delete resource[path];
  else resource[path] = toBool(value);
}

function members(resource: Resource): { value: string }[] {
  return (resource.members as { value: string }[] | undefined) ?? [];
}

function applyPatch(resource: Resource, operations: Record<string, unknown>[]): string | null {
  for (const operation of operations) {
    const op = String(operation.op).toLowerCase();
    const path = operation.path as string | undefined;
    const value = operation.value;
    if (path === undefined) {
      if (op !== 'replace' || typeof value !== 'object' || value === null) {
        return 'Unsupported path-less operation.';
      }
      for (const [k, v] of Object.entries(value)) setPath(resource, k, v);
      continue;
    }
    if (path === 'members') {
      const values = (value as { value: string }[] | undefined) ?? [];
      if (op === 'add') {
        const existing = new Set(members(resource).map((m) => m.value));
        resource.members = [
          ...members(resource),
          ...values.filter((v) => !existing.has(v.value)).map((v) => ({ value: v.value })),
        ];
      } else if (op === 'remove') {
        const drop = new Set(values.map((v) => v.value));
        resource.members = values.length
          ? members(resource).filter((m) => !drop.has(m.value))
          : [];
      } else {
        return `Unsupported op '${op}' on members.`;
      }
      continue;
    }
    const memberFilter = /^members\[value eq "([^"]+)"\]$/.exec(path);
    if (memberFilter) {
      if (op !== 'remove') return `Unsupported op '${op}' on a member filter.`;
      resource.members = members(resource).filter((m) => m.value !== memberFilter[1]);
      continue;
    }
    if (op === 'remove') setPath(resource, path, null);
    else if (op === 'replace' || op === 'add') setPath(resource, path, value);
    else return `Unsupported op '${op}'.`;
  }
  return null;
}

export interface ScimTargetOptions {
  token?: string;
  /** Serve HTTPS with a throwaway self-signed certificate. */
  tls?: boolean;
}

/** Start a SCIM test double on an ephemeral loopback port. */
export async function startScimTarget(options: ScimTargetOptions = {}): Promise<ScimTarget> {
  const token = options.token ?? 'scim-test-token';
  const requests: RecordedRequest[] = [];
  const users = new Map<string, Resource>();
  const groups = new Map<string, Resource>();
  let rules: FailureRule[] = [];
  let next = 1;
  const newId = (prefix: string) => `${prefix}-${String(next++).padStart(4, '0')}`;

  function store(path: string): [Map<string, Resource>, 'u' | 'g'] | undefined {
    if (path.startsWith('/Users')) return [users, 'u'];
    if (path.startsWith('/Groups')) return [groups, 'g'];
    return undefined;
  }

  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://scim.test');
      const path = url.pathname.replace(/^\/scim\/v2/, '');
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path,
        filter: url.searchParams.get('filter'),
        query: url.searchParams,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
      };
      requests.push(recorded);

      const send = (status: number, body?: unknown) => {
        res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/scim+json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };

      for (const rule of rules) {
        const forced = rule(recorded);
        if (forced === 'hang') return; // never respond
        if (forced !== undefined) return send(forced, scimError(forced, 'Scripted failure.'));
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(401, scimError(401, 'Invalid bearer token.'));
      }
      const target = store(path);
      if (!target) return send(404, scimError(404, 'Unknown resource type.'));
      const [map, prefix] = target;
      const id = decodeURIComponent(path.split('/')[2] ?? '');

      if (recorded.method === 'GET' && !id) {
        const parsed = recorded.filter ? parseEqFilter(recorded.filter) : undefined;
        let found = [...map.values()];
        if (parsed) {
          found = found.filter((r) => {
            const v = r[parsed.attr];
            return typeof v === 'string' && v.toLowerCase() === parsed.value.toLowerCase();
          });
        }
        const exclude = url.searchParams.get('excludedAttributes') === 'members';
        return send(200, {
          schemas: [LIST_SCHEMA],
          totalResults: found.length,
          startIndex: 1,
          itemsPerPage: found.length,
          Resources: found.map((r) => (exclude ? { ...r, members: undefined } : r)),
        });
      }
      if (recorded.method === 'GET') {
        const r = map.get(id);
        return r ? send(200, r) : send(404, scimError(404, 'Not found.'));
      }
      if (recorded.method === 'POST' && !id) {
        const body = { ...(recorded.body ?? {}) };
        if (prefix === 'u') {
          const clash = [...users.values()].some(
            (u) => String(u.userName).toLowerCase() === String(body.userName).toLowerCase(),
          );
          if (clash) return send(409, scimError(409, 'userName already exists.'));
        }
        const created: Resource = { ...body, id: newId(prefix) };
        map.set(created.id, created);
        return send(201, created);
      }
      if (recorded.method === 'PATCH' && id) {
        const r = map.get(id);
        if (!r) return send(404, scimError(404, 'Not found.'));
        const error = applyPatch(r, (recorded.body?.Operations as Record<string, unknown>[]) ?? []);
        return error ? send(400, scimError(400, error)) : send(200, r);
      }
      if (recorded.method === 'DELETE' && id) {
        if (!map.delete(id)) return send(404, scimError(404, 'Not found.'));
        if (prefix === 'u') {
          for (const g of groups.values()) g.members = members(g).filter((m) => m.value !== id);
        }
        return send(204);
      }
      return send(405, scimError(405, 'Method not allowed.'));
    });
  };

  let server: http.Server;
  if (options.tls) {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      days: 1,
      keySize: 2048,
    });
    server = https.createServer({ key: pems.private, cert: pems.cert }, handler);
  } else {
    server = http.createServer(handler);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const scheme = options.tls ? 'https' : 'http';

  return {
    url: `${scheme}://127.0.0.1:${port}/scim/v2`,
    token,
    requests,
    users,
    groups,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    failWhen: (rule) => {
      rules.push(rule);
    },
    clearRules: () => {
      rules = [];
    },
    seedUser: (resource) => {
      const r = { ...resource, id: newId('u') } as Resource;
      users.set(r.id, r);
      return r;
    },
    seedGroup: (resource) => {
      const r = { ...resource, id: newId('g') } as Resource;
      groups.set(r.id, r);
      return r;
    },
    memberIds: (groupId) => members(groups.get(groupId) as Resource).map((m) => m.value),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
