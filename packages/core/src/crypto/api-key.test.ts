// Unit tests for API key parsing and hashing (docs/SECURITY.md#api-key-handling).
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashApiKey, parseApiKey, verifyApiKeyHash } from './api-key.js';

const KEY = 'hdl_demo1234_devkeydevkeydevkeydevkeydevkey00';

describe('parseApiKey', () => {
  it('splits a well-formed key into prefix and secret', () => {
    expect(parseApiKey(KEY)).toEqual({
      prefix: 'demo1234',
      secret: 'devkeydevkeydevkeydevkeydevkey00',
    });
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'sk_demo1234_devkeydevkeydevkeydevkeydevkey00'],
    ['short prefix', 'hdl_demo123_devkeydevkeydevkeydevkeydevkey00'],
    ['short secret', 'hdl_demo1234_devkey'],
    ['long secret', `${KEY}0`],
    ['a symbol in the secret', 'hdl_demo1234_devkeydevkeydevkeydevkeydevkey0!'],
    ['a trailing newline', `${KEY}\n`],
    ['a Bearer prefix', `Bearer ${KEY}`],
  ])('returns null for a key that is %s', (_label, key) => {
    expect(parseApiKey(key)).toBeNull();
  });
});

describe('hashApiKey and verifyApiKeyHash', () => {
  it('hashes to the SHA-256 hex of the full key', () => {
    const expected = crypto.createHash('sha256').update(KEY).digest('hex');

    expect(hashApiKey(KEY)).toBe(expected);
    expect(hashApiKey(KEY)).toHaveLength(64);
  });

  it('accepts the key that produced the stored hash', () => {
    expect(verifyApiKeyHash(KEY, hashApiKey(KEY))).toBe(true);
  });

  it('rejects another key', () => {
    const other = 'hdl_demo1234_devkeydevkeydevkeydevkeydevkey01';
    expect(verifyApiKeyHash(other, hashApiKey(KEY))).toBe(false);
  });

  it('rejects a stored hash of the wrong length without throwing', () => {
    expect(verifyApiKeyHash(KEY, 'abcd')).toBe(false);
    expect(verifyApiKeyHash(KEY, '')).toBe(false);
  });
});
