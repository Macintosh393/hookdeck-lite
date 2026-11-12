// Encryption of source and destination secrets at rest, with AES-256-GCM.
// Secrets are encrypted, not hashed, because we need the value back to compute HMACs.
// Pipeline position: ingest decrypts a source secret, delivery decrypts a signing secret.
// Spec: docs/SECURITY.md#secret-encryption
import crypto from 'node:crypto';
import { MASTER_KEY_BYTES } from '../env.js';

const ENVELOPE_VERSION = 'v1';
/** Id of the master key in use. Stored in every envelope so the key can be rotated later (C5). */
const KEY_ID = 'k1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type SecretPurpose = 'source-secret' | 'destination-secret';

/** What a ciphertext is bound to. Decryption fails unless the same context is supplied. */
export interface SecretContext {
  tenantId: string;
  purpose: SecretPurpose;
}

/** Decodes SECRETS_MASTER_KEY. Throws unless it is the base64 of exactly 32 bytes. */
export function parseMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== MASTER_KEY_BYTES || key.toString('base64') !== base64Key) {
    throw new Error(
      `SECRETS_MASTER_KEY must be the base64 encoding of exactly ${MASTER_KEY_BYTES} bytes`,
    );
  }
  return key;
}

/**
 * The AAD (additional authenticated data): not secret and not stored, but mixed into the auth
 * tag. A ciphertext copied to another tenant's row, or from a source to a destination, has a
 * different AAD at decryption time and is rejected.
 */
function additionalData(context: SecretContext): Buffer {
  return Buffer.from(`${context.tenantId}:${context.purpose}`, 'utf8');
}

/** Returns the envelope `v1:k1:<iv>:<ciphertext>:<tag>`, each part base64. */
export function encryptSecret(
  plaintext: string,
  masterKey: Buffer,
  context: SecretContext,
): string {
  // LEARN: GCM needs a nonce (the IV) that is never used twice with the same key: a repeat lets
  // an attacker recover plaintext. So every encryption draws 12 fresh random bytes. The auth tag
  // is a checksum only the key holder can produce: if the ciphertext, IV or AAD was changed,
  // decryption throws instead of returning garbage. See docs/learning/ssrf-and-network-security.md#encrypting-secrets-at-rest
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(additionalData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    KEY_ID,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

/** Reverses encryptSecret. Throws if the envelope is malformed, tampered with, or bound to another context. */
export function decryptSecret(envelope: string, masterKey: Buffer, context: SecretContext): string {
  const parts = envelope.split(':');
  const [version, keyId, ivPart, ciphertextPart, tagPart] = parts;
  if (
    parts.length !== 5 ||
    version !== ENVELOPE_VERSION ||
    keyId !== KEY_ID ||
    ivPart === undefined ||
    ciphertextPart === undefined ||
    tagPart === undefined
  ) {
    throw new Error('Unsupported secret envelope');
  }

  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw new Error('Malformed secret envelope');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(tag);
  // final() is where the tag is checked. It throws if anything does not match.
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
