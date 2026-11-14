// Unit tests for classifyResponse: one case per row of docs/QUEUES.md#response-classification.
import { describe, expect, it } from 'vitest';
import { classifyResponse } from './classify.js';
import type { Classification, TransportErrorCode } from './classify.js';

const response = (statusCode: number): Classification =>
  classifyResponse({ kind: 'response', statusCode });
const failure = (errorCode: TransportErrorCode): Classification =>
  classifyResponse({ kind: 'error', errorCode });

describe('classifyResponse', () => {
  it.each([200, 201, 202, 204, 299])('AC7.1 %i is SUCCESS', (status) => {
    expect(response(status)).toEqual({
      outcome: 'SUCCESS',
      errorCode: null,
      honorsRetryAfter: false,
    });
  });

  it.each([300, 301, 302, 303, 307, 308, 399])(
    'AC7.3 %i is PERMANENT_FAILURE / REDIRECT_NOT_FOLLOWED',
    (status) => {
      expect(response(status)).toEqual({
        outcome: 'PERMANENT_FAILURE',
        errorCode: 'REDIRECT_NOT_FOLLOWED',
        honorsRetryAfter: false,
      });
    },
  );

  it('AC7.2 408 is RETRYABLE_FAILURE and does not honor Retry-After', () => {
    expect(response(408)).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'HTTP_ERROR',
      honorsRetryAfter: false,
    });
  });

  it('AC7.2 429 is RETRYABLE_FAILURE and honors Retry-After', () => {
    expect(response(429)).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'HTTP_ERROR',
      honorsRetryAfter: true,
    });
  });

  it.each([400, 401, 403, 404, 405, 409, 410, 413, 418, 422, 451, 499])(
    'AC7.3 %i (any other 4xx) is PERMANENT_FAILURE / HTTP_ERROR',
    (status) => {
      expect(response(status)).toEqual({
        outcome: 'PERMANENT_FAILURE',
        errorCode: 'HTTP_ERROR',
        honorsRetryAfter: false,
      });
    },
  );

  it('AC7.2 503 is RETRYABLE_FAILURE and honors Retry-After', () => {
    expect(response(503)).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'HTTP_ERROR',
      honorsRetryAfter: true,
    });
  });

  it.each([500, 501, 502, 504, 520, 599])(
    'AC7.2 %i (any other 5xx) is RETRYABLE_FAILURE without Retry-After',
    (status) => {
      expect(response(status)).toEqual({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'HTTP_ERROR',
        honorsRetryAfter: false,
      });
    },
  );

  it.each([100, 101, 103, 199, 0, 99, 600, 999, -1])(
    'a 1xx or out-of-range status (%i) is RETRYABLE_FAILURE / HTTP_ERROR',
    (status) => {
      expect(response(status)).toEqual({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'HTTP_ERROR',
        honorsRetryAfter: false,
      });
    },
  );

  it.each(['TIMEOUT', 'NETWORK_ERROR', 'DNS_ERROR', 'TLS_ERROR'] as const)(
    'AC7.2 a %s is RETRYABLE_FAILURE with that error code',
    (errorCode) => {
      expect(failure(errorCode)).toEqual({
        outcome: 'RETRYABLE_FAILURE',
        errorCode,
        honorsRetryAfter: false,
      });
    },
  );

  it('SSRF_BLOCKED is PERMANENT_FAILURE: retrying cannot make a blocked address allowed', () => {
    expect(failure('SSRF_BLOCKED')).toEqual({
      outcome: 'PERMANENT_FAILURE',
      errorCode: 'SSRF_BLOCKED',
      honorsRetryAfter: false,
    });
  });
});
