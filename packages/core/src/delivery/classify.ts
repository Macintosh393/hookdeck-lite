// Decides what the result of one delivery attempt means: success, try again later, or give up.
// Pipeline position: delivery, right after the HTTP request. A pure function.
// The table in docs/QUEUES.md#response-classification is its specification and its test list.
import type { AttemptErrorCode, AttemptOutcome } from '@hdl/shared';

/** Error codes of an attempt that got no HTTP response at all. */
export type TransportErrorCode = Extract<
  AttemptErrorCode,
  'TIMEOUT' | 'NETWORK_ERROR' | 'DNS_ERROR' | 'TLS_ERROR' | 'SSRF_BLOCKED'
>;

/** What came back from the SSRF-safe client: a status code, or the reason there is none. */
export type AttemptResult =
  { kind: 'response'; statusCode: number } | { kind: 'error'; errorCode: TransportErrorCode };

export interface Classification {
  outcome: AttemptOutcome;
  /** Null only for SUCCESS. */
  errorCode: AttemptErrorCode | null;
  /** True for 429 and 503: the response's Retry-After header becomes a floor on the delay. */
  honorsRetryAfter: boolean;
}

const success: Classification = { outcome: 'SUCCESS', errorCode: null, honorsRetryAfter: false };

const retryable = (errorCode: AttemptErrorCode, honorsRetryAfter = false): Classification => ({
  outcome: 'RETRYABLE_FAILURE',
  errorCode,
  honorsRetryAfter,
});

const permanent = (errorCode: AttemptErrorCode): Classification => ({
  outcome: 'PERMANENT_FAILURE',
  errorCode,
  honorsRetryAfter: false,
});

/**
 * Retryable means "the same request might succeed later" (overload, restart, unreachable).
 * Permanent means "the receiver understood and refused": a human must fix something, then replay.
 */
export function classifyResponse(result: AttemptResult): Classification {
  if (result.kind === 'error') {
    // The address was refused before any byte was sent. Retrying cannot change that.
    if (result.errorCode === 'SSRF_BLOCKED') return permanent('SSRF_BLOCKED');
    return retryable(result.errorCode);
  }

  const status = result.statusCode;
  if (status >= 200 && status <= 299) return success;
  // We never follow redirects (docs/SECURITY.md#ssrf-protection); the operator must fix the URL.
  if (status >= 300 && status <= 399) return permanent('REDIRECT_NOT_FOLLOWED');
  if (status === 408) return retryable('HTTP_ERROR');
  if (status === 429) return retryable('HTTP_ERROR', true);
  if (status >= 400 && status <= 499) return permanent('HTTP_ERROR');
  if (status === 503) return retryable('HTTP_ERROR', true);
  // Every other 5xx, 1xx, and anything outside 100–599: treat as a transient server problem.
  return retryable('HTTP_ERROR');
}
