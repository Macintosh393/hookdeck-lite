// Unit tests for reading the Authorization header. The guard itself (database lookup, hash
// comparison, revoked keys) is tested against Postgres in test/auth.int.test.ts.
import { describe, expect, it } from 'vitest';
import { parseBearerToken } from './api-key.guard.js';

describe('parseBearerToken', () => {
  it('returns the token of a Bearer header', () => {
    expect(parseBearerToken('Bearer hdl_demo1234_abc')).toBe('hdl_demo1234_abc');
  });

  it('accepts the scheme in any case, as HTTP defines it', () => {
    expect(parseBearerToken('bearer token-1')).toBe('token-1');
    expect(parseBearerToken('BEARER token-1')).toBe('token-1');
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the scheme alone', 'Bearer'],
    ['the scheme and a space', 'Bearer '],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare key without a scheme', 'hdl_demo1234_abc'],
    ['two tokens', 'Bearer one two'],
    ['a leading space', ' Bearer token-1'],
    ['a repeated header (an array)', ['Bearer a', 'Bearer b']],
  ])('returns null for %s', (_label, header) => {
    expect(parseBearerToken(header)).toBeNull();
  });
});
