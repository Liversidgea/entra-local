import http from 'node:http';
import https from 'node:https';
import { appVersion } from '../version.js';

/**
 * Minimal SCIM 2.0 HTTP transport for outbound provisioning. Uses `node:http(s)` directly (no extra
 * dependency) so `allowInsecureTls` can be scoped to a single target via `rejectUnauthorized`.
 * Requests only ever go to the configured tenant URL; URLs returned by the target are not followed.
 */

/** Per-request timeout (spec: 30 s). */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ScimTarget {
  tenantUrl: string;
  secretToken: string;
  allowInsecureTls: boolean;
}

export interface ScimResponse {
  /** `null` when no HTTP response was received (network/TLS/timeout error). */
  status: number | null;
  /** Raw response text (may be empty). */
  text: string;
  /** Parsed JSON body, when the response was JSON. */
  json: Record<string, unknown> | null;
  /** Transport-level error message when `status` is null. */
  error: string | null;
  /** Whether the transport error was a TLS certificate failure. */
  tlsError: boolean;
}

/** Strip a trailing slash so resource paths can be appended. */
export function normalizeTenantUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Build the absolute URL for a path relative to the tenant URL (e.g. `/Users?filter=...`). */
export function targetUrl(target: ScimTarget, path: string): string {
  return `${normalizeTenantUrl(target.tenantUrl)}${path}`;
}

/** Send one SCIM request. Never throws: transport failures are reported in the result. */
export function scimRequest(
  target: ScimTarget,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<ScimResponse> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({
        status: null,
        text: '',
        json: null,
        error: `Invalid URL '${url}'.`,
        tlsError: false,
      });
      return;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${target.secretToken}`,
      accept: 'application/scim+json',
      'user-agent': `Entra-Local-Provisioning/${appVersion()}`,
    };
    if (payload !== undefined) {
      headers['content-type'] = 'application/scim+json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request(
      parsed,
      {
        method,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        ...(isHttps ? { rejectUnauthorized: !target.allowInsecureTls } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          if (text.trim() !== '') {
            try {
              const value = JSON.parse(text) as unknown;
              if (value !== null && typeof value === 'object') {
                json = value as Record<string, unknown>;
              }
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? null, text, json, error: null, tlsError: false });
        });
        res.on('error', (err) =>
          resolve({ status: null, text: '', json: null, error: err.message, tlsError: false }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
    });
    req.on('error', (err: Error & { code?: string }) => {
      resolve({
        status: null,
        text: '',
        json: null,
        error: err.code ? `${err.code}: ${err.message}` : err.message,
        tlsError: err.code !== undefined && TLS_ERROR_CODES.has(err.code),
      });
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Read the `Resources` array of a SCIM ListResponse; `undefined` when the body isn't one. */
export function listResources(json: Record<string, unknown> | null): Record<string, unknown>[] | undefined {
  if (!json) return undefined;
  const resources = json.Resources;
  if (Array.isArray(resources)) return resources as Record<string, unknown>[];
  if (typeof json.totalResults === 'number' && json.totalResults === 0) return [];
  return undefined;
}
