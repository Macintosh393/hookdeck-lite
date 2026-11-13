// Unit tests for secret encryption at rest. Test names carry the checklist ids
// (docs/SECURITY.md#security-test-checklist, "Secret encryption").
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseMasterKey } from './secret-encryption.js';
import type { SecretContext } from './secret-encryption.js';

const masterKey = crypto.randomBytes(32);
const context: SecretContext = { tenantId: 'tenant-a', purpose: 'source-secret' };
const PLAINTEXT = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

/** Flips one bit in one base64 part of the envelope (2 = IV, 3 = ciphertext, 4 = tag). */
function tamper(envelope: string, partIndex: number): string {
  const parts = envelope.split(':');
  const bytes = Buffer.from(parts[partIndex]!, 'base64');
  bytes[0] = bytes[0]! ^ 0b0000_0001;
  parts[partIndex] = bytes.toString('base64');
  return parts.join(':');
}

describe('secret encryption', () => {
  it('SEC-ENC-01 decrypts what it encrypted', () => {
    const envelope = encryptSecret(PLAINTEXT, masterKey, context);

    expect(envelope).toMatch(/^v1:k1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(envelope).not.toContain(PLAINTEXT);
    expect(decryptSecret(envelope, masterKey, context)).toBe(PLAINTEXT);
  });

  it('SEC-ENC-01 round-trips non-ASCII secrets', () => {
    const secret = 'pässwörd-秘密-🔑';
    expect(decryptSecret(encryptSecret(secret, masterKey, context), masterKey, context)).toBe(
      secret,
    );
  });

  it('SEC-ENC-02 produces a different envelope each time (random IV)', () => {
    const first = encryptSecret(PLAINTEXT, masterKey, context);
    const second = encryptSecret(PLAINTEXT, masterKey, context);

    expect(first).not.toBe(second);
    expect(first.split(':')[2]).not.toBe(second.split(':')[2]); // the IVs differ
  });

  it.each([
    ['IV', 2],
    ['ciphertext', 3],
    ['auth tag', 4],
  ])('SEC-ENC-03 throws when one byte of the %s is changed', (_label, partIndex) => {
    const envelope = encryptSecret(PLAINTEXT, masterKey, context);

    expect(() => decryptSecret(tamper(envelope, partIndex), masterKey, context)).toThrow();
  });

  it('SEC-ENC-04 throws when decrypting for another tenant', () => {
    const envelope = encryptSecret(PLAINTEXT, masterKey, context);

    expect(() =>
      decryptSecret(envelope, masterKey, { ...context, tenantId: 'tenant-b' }),
    ).toThrow();
  });

  it('SEC-ENC-04 throws when decrypting for another purpose', () => {
    const envelope = encryptSecret(PLAINTEXT, masterKey, context);

    expect(() =>
      decryptSecret(envelope, masterKey, { ...context, purpose: 'destination-secret' }),
    ).toThrow();
  });

  it('throws when decrypting with a different master key', () => {
    const envelope = encryptSecret(PLAINTEXT, masterKey, context);

    expect(() => decryptSecret(envelope, crypto.randomBytes(32), context)).toThrow();
  });

  it.each(['', 'plaintext', 'v2:k1:a:b:c', 'v1:k9:a:b:c', 'v1:k1:AAAA:AAAA:AAAA', 'v1:k1:a:b'])(
    'throws on a malformed envelope: %j',
    (envelope) => {
      expect(() => decryptSecret(envelope, masterKey, context)).toThrow();
    },
  );
});

describe('parseMasterKey', () => {
  it('accepts the base64 of exactly 32 bytes', () => {
    expect(parseMasterKey(masterKey.toString('base64')).equals(masterKey)).toBe(true);
  });

  it.each([
    ['16 bytes', crypto.randomBytes(16).toString('base64')],
    ['31 bytes', crypto.randomBytes(31).toString('base64')],
    ['33 bytes', crypto.randomBytes(33).toString('base64')],
    ['an empty string', ''],
    ['text that is not base64', 'not base64 at all, just a sentence.'],
  ])('SEC-ENC-05 rejects a key of %s', (_label, key) => {
    expect(() => parseMasterKey(key)).toThrow(/exactly 32 bytes/);
  });
});
