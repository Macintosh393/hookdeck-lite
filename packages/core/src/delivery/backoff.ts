// The retry delay of a failed delivery attempt: exponential backoff with full jitter, a cap, and
// Retry-After as a floor. Pipeline position: delivery, after an attempt is classified as retryable.
// A pure function: the random source is a parameter, so tests are deterministic.
// Spec and worked table: docs/QUEUES.md#backoff

export interface BackoffInput {
  /** The number of the attempt that just failed, 1-based. */
  attemptNumber: number;
  /** The receiver's Retry-After in milliseconds. Pass it only for 429 and 503; otherwise null. */
  retryAfterMs: number | null;
  /** BACKOFF_BASE_MS: the ceiling after the first failure. */
  baseMs: number;
  /** BACKOFF_CAP_MS: no single wait is longer than this. */
  capMs: number;
  /** Returns a number in [0, 1). Default: Math.random. Tests pass a fixed value. */
  random?: () => number;
}

/** The largest delay allowed after attempt `attemptNumber`: base × 2^(n − 1), at most the cap. */
export function backoffCeiling(attemptNumber: number, baseMs: number, capMs: number): number {
  const n = Math.max(1, Math.floor(attemptNumber));
  // 2 ** (n - 1) becomes Infinity for a very large n; Math.min then returns the cap.
  return Math.min(capMs, baseMs * 2 ** (n - 1));
}

/** How long to wait before the next attempt, in whole milliseconds. */
export function computeBackoffDelay(input: BackoffInput): number {
  const random = input.random ?? Math.random;
  const ceiling = backoffCeiling(input.attemptNumber, input.baseMs, input.capMs);

  // LEARN: "full jitter". The delay is random between 0 and the ceiling, not the ceiling itself.
  // Deliveries that failed together would otherwise all retry at the same instants and hit a
  // recovering destination in waves. See docs/learning/reliability-patterns.md#backoff-and-jitter
  const jittered = Math.floor(random() * ceiling);

  // The receiver's Retry-After is a floor, itself capped: a hostile or broken receiver must not
  // be able to park a job for a year (docs/SECURITY.md, threat T15).
  const retryAfter = Math.min(Math.max(0, input.retryAfterMs ?? 0), input.capMs);

  return Math.max(jittered, retryAfter);
}
