// Parses the Retry-After response header. Pipeline position: delivery, between the HTTP response
// and the backoff calculation. Spec: docs/QUEUES.md#backoff
//
// The header has two forms (RFC 9110): a number of seconds ("120") or an HTTP date
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Anything else is ignored.

/**
 * The largest value returned. DeliveryAttempt.retryAfterMs is a 32-bit Postgres integer, so a
 * receiver answering `Retry-After: 99999999999` must not make the INSERT of the attempt fail.
 * The delay actually used is capped much lower anyway, by BACKOFF_CAP_MS.
 */
export const MAX_RETRY_AFTER_MS = 2_147_483_647;

/** The date format HTTP senders must use ("IMF-fixdate"). We accept only this one. */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Returns the wait the receiver asked for, in milliseconds from `nowMs`, or null when the header
 * is missing, unparsable, negative, or a date in the past.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Digits only: "-5", "1.5" and "12abc" are not valid delay-seconds.
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }

  if (!IMF_FIXDATE.test(trimmed)) return null;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;

  const waitMs = dateMs - nowMs;
  if (waitMs <= 0) return null; // a date in the past asks for nothing
  return Math.min(waitMs, MAX_RETRY_AFTER_MS);
}
