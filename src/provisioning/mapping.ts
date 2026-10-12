import type { Group, PatchDialect, User } from '../store/types.js';

/**
 * Entra's default SCIM attribute mappings (spec "Default attribute mappings"), plus the flattened
 * attribute model used to diff the last-synced state and build PATCH operations.
 *
 * A flat attribute map is keyed by the SCIM PATCH `path` of each mapped attribute, so a changed key
 * is directly an operation path. `null` means "not set" (omitted on create, `remove` on update).
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

/** Max members per PATCH operation (Entra batches group membership changes in 50s). */
export const MEMBER_BATCH = 50;

export type FlatAttrs = Record<string, string | boolean | null>;

const WORK_EMAIL = 'emails[type eq "work"].value';

/** The emulator's stand-in for Entra's `mailNickname`: the UPN local part. */
export function mailNickname(upn: string): string {
  const at = upn.indexOf('@');
  return at === -1 ? upn : upn.slice(0, at);
}

/** Flattened desired SCIM attributes for a user. */
export function userAttrs(user: User): FlatAttrs {
  return {
    userName: user.userPrincipalName,
    active: user.accountEnabled,
    displayName: user.displayName,
    'name.givenName': user.givenName,
    'name.familyName': user.surname,
    [WORK_EMAIL]: user.mail,
    externalId: mailNickname(user.userPrincipalName),
  };
}

/** Flattened desired SCIM attributes for a group (membership is diffed separately). */
export function groupAttrs(group: Group): FlatAttrs {
  return { displayName: group.displayName, externalId: group.id };
}

/** Full SCIM User resource for `POST /Users`, omitting unset attributes. */
export function userResource(attrs: FlatAttrs): Record<string, unknown> {
  const name: Record<string, string> = {};
  if (attrs['name.givenName'] != null) name.givenName = attrs['name.givenName'] as string;
  if (attrs['name.familyName'] != null) name.familyName = attrs['name.familyName'] as string;
  return {
    schemas: [SCIM_USER_SCHEMA],
    userName: attrs.userName,
    active: attrs.active,
    displayName: attrs.displayName,
    ...(Object.keys(name).length > 0 ? { name } : {}),
    ...(attrs[WORK_EMAIL] != null
      ? { emails: [{ value: attrs[WORK_EMAIL], type: 'work', primary: true }] }
      : {}),
    externalId: attrs.externalId,
  };
}

/**
 * SCIM Group resource for `POST /Groups`. Entra creates groups without members and adds them in a
 * follow-up PATCH, so this never carries `members`.
 */
export function groupResource(attrs: FlatAttrs): Record<string, unknown> {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    displayName: attrs.displayName,
    externalId: attrs.externalId,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Flatten a SCIM User resource returned by the target into the same shape as {@link userAttrs}. */
export function flattenUserResource(resource: Record<string, unknown>): FlatAttrs {
  const name = (resource.name ?? {}) as Record<string, unknown>;
  const emails = Array.isArray(resource.emails)
    ? (resource.emails as Record<string, unknown>[])
    : [];
  const email =
    emails.find((e) => e.type === 'work') ?? emails.find((e) => e.primary === true) ?? emails[0];
  const active = resource.active;
  return {
    userName: str(resource.userName),
    active:
      typeof active === 'boolean'
        ? active
        : typeof active === 'string'
          ? active.toLowerCase() === 'true'
          : true,
    displayName: str(resource.displayName),
    'name.givenName': str(name.givenName),
    'name.familyName': str(name.familyName),
    [WORK_EMAIL]: str(email?.value),
    externalId: str(resource.externalId),
  };
}

/** Flatten a SCIM Group resource returned by the target. */
export function flattenGroupResource(resource: Record<string, unknown>): FlatAttrs {
  return { displayName: str(resource.displayName), externalId: str(resource.externalId) };
}

/** `userName` matching is case-insensitive (SCIM `caseExact: false`); everything else is exact. */
function sameValue(key: string, a: FlatAttrs[string], b: FlatAttrs[string]): boolean {
  if (key === 'userName' && typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Attributes written only on create, never PATCHed. `externalId` is the source's identifier on the
 * target; SCIM servers commonly treat it as immutable (Keycloak rejects changes), and on adoption a
 * different tenant may legitimately own it.
 */
export const CREATE_ONLY_ATTRIBUTES: ReadonlySet<string> = new Set(['externalId']);

/** Keys whose value differs between the previous and desired attribute maps (create-only excluded). */
export function changedKeys(previous: FlatAttrs, desired: FlatAttrs): string[] {
  return Object.keys(desired).filter(
    (key) =>
      !CREATE_ONLY_ATTRIBUTES.has(key) &&
      !sameValue(key, previous[key] ?? null, desired[key] ?? null),
  );
}

export interface PatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

function opName(op: 'add' | 'replace' | 'remove', dialect: PatchDialect): string {
  return dialect === 'legacy' ? op[0]!.toUpperCase() + op.slice(1) : op;
}

function opValue(value: string | boolean, dialect: PatchDialect): string | boolean {
  if (typeof value === 'boolean' && dialect === 'legacy') return value ? 'True' : 'False';
  return value;
}

/** One `replace` (or `remove` for a now-unset value) operation per changed attribute. */
export function attributeOperations(
  desired: FlatAttrs,
  keys: string[],
  dialect: PatchDialect,
): PatchOperation[] {
  return keys.map((path) => {
    const value = desired[path];
    if (value == null) return { op: opName('remove', dialect), path };
    return { op: opName('replace', dialect), path, value: opValue(value, dialect) };
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `add` member operations, at most {@link MEMBER_BATCH} members each. */
export function addMemberOperations(targetIds: string[], dialect: PatchDialect): PatchOperation[] {
  return chunk(targetIds, MEMBER_BATCH).map((batch) => ({
    op: opName('add', dialect),
    path: 'members',
    value: batch.map((value) => ({ value })),
  }));
}

/**
 * Member removal. `compliant`: one filtered-path op per member; `legacy`: Entra's pre-2020 shape
 * with the members in `value`, batched by {@link MEMBER_BATCH}.
 */
export function removeMemberOperations(
  targetIds: string[],
  dialect: PatchDialect,
): PatchOperation[] {
  if (dialect === 'legacy') {
    return chunk(targetIds, MEMBER_BATCH).map((batch) => ({
      op: 'Remove',
      path: 'members',
      value: batch.map((value) => ({ value })),
    }));
  }
  return targetIds.map((id) => ({ op: 'remove', path: `members[value eq "${id}"]` }));
}

/** Wrap operations in a SCIM PatchOp message. */
export function patchBody(operations: PatchOperation[]): Record<string, unknown> {
  return { schemas: [SCIM_PATCH_SCHEMA], Operations: operations };
}

/** Escape a value for a SCIM filter string literal (RFC 7644 §3.4.2.2). */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\"]/g, (c) => `\\${c}`);
}
