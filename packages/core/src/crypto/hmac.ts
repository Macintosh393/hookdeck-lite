// HMAC-SHA256 signing and verification for webhooks, in both directions.
// Pipeline position: ingest (verify what a provider sent) and delivery (sign what we send).
// Spec: docs/SECURITY.md#inbound-verification and #outbound-signing
//
// The default import matters: calling `crypto.timingSafeEqual` through the module object lets a
// test replace it with a spy and prove which comparison function is used (SEC-IN-14).
import crypto from 'node:crypto';
import type { GenericHmacConfig, VerificationConfig } from '@hdl/shared';

const WHSEC_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';

/** Why verification failed. For the log only: the HTTP response never says which step failed. */
export type VerifyFailureReason =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'
  | 'invalid_secret';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

/** Request headers with lowercased names, as Node and Fastify provide them. */
export type HeaderBag = Record<string, string | string[] | undefined>;

export interface VerifyInboundInput {
  config: VerificationConfig;
  /** The source's decrypted secret. Null only for mode `none`. */
  secret: string | null;
  headers: HeaderBag;
  /** The exact bytes of the request body, before any JSON parsing. */
  rawBody: Buffer;
  toleranceSeconds: number;
  /** The current time, passed in so tests can pick it. */
  nowMs: number;
}

const fail = (reason: VerifyFailureReason): VerifyResult => ({ ok: false, reason });

function hmacSha256(key: Buffer, content: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(content).digest();
}

/** `{prefix}{rawBody}` as bytes. The body is never converted to a string and back. */
function signedContent(prefix: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(prefix, 'utf8'), rawBody]);
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(' ');
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Parses a Unix-seconds timestamp. Digits only: the reference library uses parseInt, which
 * would accept "123abc"; we do not. Returns null for anything else.
 */
function parseTimestamp(value: string): number | null {
  if (!/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

function isWithinTolerance(
  timestampSeconds: number,
  nowMs: number,
  toleranceSeconds: number,
): boolean {
  const nowSeconds = Math.floor(nowMs / 1000);
  // Both directions: a timestamp from the future is as suspicious as an old one.
  return Math.abs(nowSeconds - timestampSeconds) <= toleranceSeconds;
}

function signaturesMatch(candidate: Buffer, expected: Buffer): boolean {
  // LEARN: `===` on strings or Buffer.equals() stops at the first different byte, so the response
  // time leaks how many leading bytes were right. timingSafeEqual always reads every byte. It
  // throws on unequal lengths, hence the check first. See docs/learning/webhooks-101.md#timing-safe-comparison
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/** The HMAC key of a Standard Webhooks secret: the base64-decoded part after `whsec_`. */
export function decodeWhsecSecret(secret: string): Buffer {
  if (!secret.startsWith(WHSEC_PREFIX)) {
    throw new Error(`A Standard Webhooks secret must start with "${WHSEC_PREFIX}"`);
  }
  const key = Buffer.from(secret.slice(WHSEC_PREFIX.length), 'base64');
  if (key.length === 0) throw new Error('A Standard Webhooks secret must not be empty');
  return key;
}

/** A new signing secret: `whsec_` + base64 of 32 random bytes. */
export function generateWhsecSecret(): string {
  return WHSEC_PREFIX + crypto.randomBytes(32).toString('base64');
}

export interface StandardWebhookSignInput {
  /** `whsec_…` */
  secret: string;
  /** The `webhook-id` header value. */
  id: string;
  /** The `webhook-timestamp` header value: Unix seconds. */
  timestampSeconds: number;
  body: Buffer | string;
}

/** The `webhook-signature` header value: `v1,<base64 HMAC>` over `{id}.{timestamp}.{body}`. */
export function signStandardWebhook(input: StandardWebhookSignInput): string {
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const content = signedContent(`${input.id}.${input.timestampSeconds}.`, body);
  const mac = hmacSha256(decodeWhsecSecret(input.secret), content);
  return `${SIGNATURE_VERSION},${mac.toString('base64')}`;
}

export interface GenericHmacSignInput {
  secret: string;
  body: Buffer | string;
  encoding: 'hex' | 'base64';
  /** Put in front of the encoded signature, e.g. "sha256=". */
  prefix?: string;
  /** When given, the signed content is `{timestamp}.{body}`. */
  timestampSeconds?: number;
}

/** The signature header value for a `generic-hmac` source. Used by tests and the demo script. */
export function signGenericHmac(input: GenericHmacSignInput): string {
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const content =
    input.timestampSeconds === undefined ? body : signedContent(`${input.timestampSeconds}.`, body);
  const mac = hmacSha256(Buffer.from(input.secret, 'utf8'), content);
  return (input.prefix ?? '') + mac.toString(input.encoding);
}

function verifyStandardWebhook(input: VerifyInboundInput, secret: string): VerifyResult {
  const id = readHeader(input.headers, 'webhook-id');
  const timestampHeader = readHeader(input.headers, 'webhook-timestamp');
  const signatureHeader = readHeader(input.headers, 'webhook-signature');
  if (id === undefined || timestampHeader === undefined || signatureHeader === undefined) {
    return fail('missing_header');
  }

  const timestamp = parseTimestamp(timestampHeader);
  if (timestamp === null) return fail('invalid_timestamp');
  if (!isWithinTolerance(timestamp, input.nowMs, input.toleranceSeconds)) {
    return fail('timestamp_out_of_tolerance');
  }

  let key: Buffer;
  try {
    key = decodeWhsecSecret(secret);
  } catch {
    return fail('invalid_secret');
  }
  const expected = hmacSha256(key, signedContent(`${id}.${timestampHeader}.`, input.rawBody));

  // The header may hold several space-separated signatures. That is how a provider rotates its
  // key without downtime: it signs with the old and the new key for a while.
  for (const entry of signatureHeader.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1) continue;
    if (entry.slice(0, comma) !== SIGNATURE_VERSION) continue; // e.g. "v1a" (asymmetric): not ours
    const candidate = Buffer.from(entry.slice(comma + 1), 'base64');
    if (signaturesMatch(candidate, expected)) return { ok: true };
  }
  return fail('no_matching_signature');
}

function verifyGenericHmac(
  input: VerifyInboundInput,
  config: GenericHmacConfig,
  secret: string,
): VerifyResult {
  const signatureHeader = readHeader(input.headers, config.signatureHeader);
  if (signatureHeader === undefined) return fail('missing_header');

  let content = input.rawBody;
  if (config.timestampHeader !== undefined) {
    const timestampHeader = readHeader(input.headers, config.timestampHeader);
    if (timestampHeader === undefined) return fail('missing_header');
    const timestamp = parseTimestamp(timestampHeader);
    if (timestamp === null) return fail('invalid_timestamp');
    if (!isWithinTolerance(timestamp, input.nowMs, input.toleranceSeconds)) {
      return fail('timestamp_out_of_tolerance');
    }
    content = signedContent(`${timestampHeader}.`, input.rawBody);
  }

  const prefix = config.signaturePrefix ?? '';
  if (!signatureHeader.startsWith(prefix)) return fail('no_matching_signature');
  const candidate = Buffer.from(signatureHeader.slice(prefix.length), config.signatureEncoding);

  const expected = hmacSha256(Buffer.from(secret, 'utf8'), content);
  return signaturesMatch(candidate, expected) ? { ok: true } : fail('no_matching_signature');
}

/**
 * Checks an incoming webhook against its source's verification mode.
 * Order of checks (docs/SECURITY.md#algorithm): headers present, timestamp, then the HMAC.
 */
export function verifyInboundSignature(input: VerifyInboundInput): VerifyResult {
  const { config } = input;
  if (config.mode === 'none') return { ok: true };

  // A source that must verify but has no usable secret can accept nothing.
  if (input.secret === null || input.secret === '') return fail('invalid_secret');

  if (config.mode === 'standard-webhooks') return verifyStandardWebhook(input, input.secret);
  return verifyGenericHmac(input, config, input.secret);
}
