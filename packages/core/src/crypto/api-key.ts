// API key format, hashing and comparison. Keys look like `hdl_<8-char prefix>_<32-char secret>`.
// The database stores the prefix (to find the row) and a SHA-256 hash (to check the key).
// Spec: docs/SECURITY.md#api-key-handling. The seed uses this now; the ApiKeyGuard arrives on Day 2.
import crypto from 'node:crypto';

const API_KEY_PATTERN = /^hdl_([A-Za-z0-9]{8})_([A-Za-z0-9]{32})$/;

export interface ParsedApiKey {
  /** Not secret. Indexed in the database and shown in the dashboard. */
  prefix: string;
  secret: string;
}

/** Splits a key into its parts, or returns null if it does not have the exact format. */
export function parseApiKey(key: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, prefix, secret] = match;
  if (prefix === undefined || secret === undefined) return null;
  return { prefix, secret };
}

/**
 * SHA-256 hex of the full key. A fast hash is right here: slow hashes (bcrypt, argon2) protect
 * guessable passwords, and a random 32-character secret cannot be guessed.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/** True when `presentedKey` hashes to `storedHash`. Compared in constant time. */
export function verifyApiKeyHash(presentedKey: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(presentedKey), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // timingSafeEqual throws on unequal lengths; a stored hash of the wrong size never matches.
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}
