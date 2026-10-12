import { describe, expect, it } from 'vitest';
import {
  MEMBER_BATCH,
  addMemberOperations,
  attributeOperations,
  changedKeys,
  escapeFilterValue,
  flattenUserResource,
  removeMemberOperations,
  userAttrs,
  userResource,
} from '../../src/provisioning/mapping.js';
import type { User } from '../../src/store/types.js';

const user: User = {
  id: 'u1',
  tenantId: 't',
  userPrincipalName: 'jo.bloggs@contoso.test',
  displayName: 'Jo Bloggs',
  givenName: 'Jo',
  surname: null,
  mail: null,
  accountEnabled: true,
  hasPassword: false,
  createdAt: 0,
};

describe('SCIM default attribute mapping', () => {
  it('maps a user to Entra defaults and omits unset attributes', () => {
    const attrs = userAttrs(user);
    expect(attrs.externalId).toBe('jo.bloggs');
    expect(userResource(attrs)).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'jo.bloggs@contoso.test',
      active: true,
      displayName: 'Jo Bloggs',
      name: { givenName: 'Jo' },
      externalId: 'jo.bloggs',
    });
  });

  it('round-trips a target resource through flattening without spurious diffs', () => {
    const attrs = userAttrs({ ...user, mail: 'jo@contoso.test', surname: 'Bloggs' });
    const resource = { id: 'x', ...userResource(attrs), userName: 'JO.BLOGGS@contoso.test' };
    expect(changedKeys(flattenUserResource(resource), attrs)).toEqual([]);
  });

  it('reads legacy string booleans from the target', () => {
    expect(flattenUserResource({ userName: 'a', active: 'False' }).active).toBe(false);
  });
});

describe('PATCH builders', () => {
  it('builds replace/remove ops per dialect', () => {
    const attrs = { ...userAttrs(user), active: false };
    expect(attributeOperations(attrs, ['active', 'name.familyName'], 'compliant')).toEqual([
      { op: 'replace', path: 'active', value: false },
      { op: 'remove', path: 'name.familyName' },
    ]);
    expect(attributeOperations(attrs, ['active', 'name.familyName'], 'legacy')).toEqual([
      { op: 'Replace', path: 'active', value: 'False' },
      { op: 'Remove', path: 'name.familyName' },
    ]);
  });

  it(`batches member additions at ${MEMBER_BATCH}`, () => {
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
    const ops = addMemberOperations(ids, 'compliant');
    expect(ops.map((o) => (o.value as unknown[]).length)).toEqual([50, 50, 20]);
  });

  it('shapes member removal per dialect', () => {
    expect(removeMemberOperations(['a', 'b'], 'compliant')).toEqual([
      { op: 'remove', path: 'members[value eq "a"]' },
      { op: 'remove', path: 'members[value eq "b"]' },
    ]);
    expect(removeMemberOperations(['a', 'b'], 'legacy')).toEqual([
      { op: 'Remove', path: 'members', value: [{ value: 'a' }, { value: 'b' }] },
    ]);
  });

  it('escapes quotes and backslashes in filter values', () => {
    expect(escapeFilterValue('a"b\\c')).toBe('a\\"b\\\\c');
  });
});
