// Pure helpers that turn parts of an incoming request into what the Event row stores.
// Pipeline position: ingest, just before the INSERT. Limits: docs/SECURITY.md#input-limits
import type { VerificationConfig } from '@hdl/shared';

export const MAX_STORED_HEADERS = 100;
/** 8 KiB, counted in characters. */
export const MAX_HEADER_VALUE_LENGTH = 8192;
export const MAX_EXTERNAL_EVENT_ID_LENGTH = 255;
export const REDACTED = '[redacted]';

/** Headers whose value is a credential. Their names are stored, their values are not. */
const ALWAYS_REDACTED = ['authorization', 'cookie', 'webhook-signature'];

type IncomingHeaders = Record<string, string | string[] | undefined>;

/** The header names to redact for a source: the fixed list plus its own signature header. */
export function sensitiveHeaderNames(config: VerificationConfig): Set<string> {
  const names = new Set(ALWAYS_REDACTED);
  if (config.mode === 'generic-hmac') names.add(config.signatureHeader);
  return names;
}

/**
 * The headers as stored on the Event: lowercased names, at most 100, long values cut, and
 * credentials replaced by "[redacted]". The dashboard shows these, so they must hold no secret.
 */
export function toStoredHeaders(
  headers: IncomingHeaders,
  sensitiveNames: Set<string>,
): Record<string, string> {
  const stored: Record<string, string> = {};
  let count = 0;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    if (count >= MAX_STORED_HEADERS) break;
    const name = rawName.toLowerCase();
    // A header sent more than once arrives as an array.
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
    stored[name] = sensitiveNames.has(name) ? REDACTED : value.slice(0, MAX_HEADER_VALUE_LENGTH);
    count += 1;
  }
  return stored;
}

/** Postgres cannot store the NUL character in text or jsonb. A query string can carry one (%00). */
const withoutNul = (value: string): string => value.replaceAll('\u0000', '');

/** The parsed query string as stored on the Event: string and string-array values only. */
export function toStoredQuery(query: unknown): Record<string, string | string[]> {
  const stored: Record<string, string | string[]> = {};
  if (typeof query !== 'object' || query === null) return stored;

  for (const [name, value] of Object.entries(query)) {
    if (typeof value === 'string') {
      stored[withoutNul(name)] = withoutNul(value);
    } else if (Array.isArray(value)) {
      stored[withoutNul(name)] = value.filter((v) => typeof v === 'string').map(withoutNul);
    }
  }
  return stored;
}

/**
 * The provider's id for this event, read from the source's dedupe header and cut to 255
 * characters. Null means "do not deduplicate": no header configured, or the request has none.
 */
export function readExternalEventId(
  headers: IncomingHeaders,
  dedupeHeader: string | null,
): string | null {
  if (dedupeHeader === null) return null;
  const value = headers[dedupeHeader.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === '') return null;
  return first.slice(0, MAX_EXTERNAL_EVENT_ID_LENGTH);
}

/** True for `application/json`, with or without parameters such as `; charset=utf-8`. */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mediaType = contentType.split(';')[0] ?? '';
  return mediaType.trim().toLowerCase() === 'application/json';
}
