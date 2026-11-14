// Unit tests for decideNextState: step 6 of docs/QUEUES.md#delivery-processor as a pure function.
// The processor around it is tested against Postgres and Redis in test/delivery.int.test.ts.
import { classifyResponse } from '@hdl/core';
import { describe, expect, it } from 'vitest';
import { decideNextState } from './delivery.processor.js';

const base = {
  maxAttempts: 4,
  retryAfterMs: null,
  baseMs: 20,
  capMs: 200,
  random: () => 0.5,
};
const status = (statusCode: number) => classifyResponse({ kind: 'response', statusCode });

describe('decideNextState', () => {
  it('AC7.1 a success is SUCCEEDED, on any attempt', () => {
    for (const attemptNumber of [1, 4]) {
      expect(decideNextState({ ...base, classification: status(204), attemptNumber })).toEqual({
        status: 'SUCCEEDED',
      });
    }
  });

  it('AC7.3 a permanent failure is DEAD at once, even with attempts left', () => {
    expect(decideNextState({ ...base, classification: status(404), attemptNumber: 1 })).toEqual({
      status: 'DEAD',
      deadReason: 'PERMANENT_FAILURE',
    });
    expect(
      decideNextState({
        ...base,
        classification: classifyResponse({ kind: 'error', errorCode: 'SSRF_BLOCKED' }),
        attemptNumber: 1,
      }),
    ).toEqual({ status: 'DEAD', deadReason: 'PERMANENT_FAILURE' });
  });

  it('AC7.2 a retryable failure with attempts left is RETRYING with the jittered delay', () => {
    // Ceilings 20, 40, 80 ms; the random source at 0.5 gives half of each.
    expect(
      [1, 2, 3].map((attemptNumber) =>
        decideNextState({ ...base, classification: status(500), attemptNumber }),
      ),
    ).toEqual([
      { status: 'RETRYING', delayMs: 10 },
      { status: 'RETRYING', delayMs: 20 },
      { status: 'RETRYING', delayMs: 40 },
    ]);
  });

  it('AC7.4 a retryable failure on the last attempt is DEAD with RETRIES_EXHAUSTED', () => {
    expect(decideNextState({ ...base, classification: status(503), attemptNumber: 4 })).toEqual({
      status: 'DEAD',
      deadReason: 'RETRIES_EXHAUSTED',
    });
    // Postgres is the counter of record: a count past the maximum is exhausted too, never a retry.
    expect(decideNextState({ ...base, classification: status(503), attemptNumber: 9 })).toEqual({
      status: 'DEAD',
      deadReason: 'RETRIES_EXHAUSTED',
    });
  });

  it('AC7.5 Retry-After is a floor on the delay for 429 and 503, and capped at BACKOFF_CAP_MS', () => {
    const withRetryAfter = { ...base, attemptNumber: 1, retryAfterMs: 150 };

    expect(decideNextState({ ...withRetryAfter, classification: status(503) })).toEqual({
      status: 'RETRYING',
      delayMs: 150,
    });
    expect(decideNextState({ ...withRetryAfter, classification: status(429) })).toEqual({
      status: 'RETRYING',
      delayMs: 150,
    });
    expect(
      decideNextState({ ...withRetryAfter, retryAfterMs: 60_000, classification: status(503) }),
    ).toEqual({ status: 'RETRYING', delayMs: 200 });
  });

  it('AC7.5 Retry-After on any other status is ignored', () => {
    for (const statusCode of [500, 502, 408]) {
      expect(
        decideNextState({
          ...base,
          attemptNumber: 1,
          retryAfterMs: 150,
          classification: status(statusCode),
        }),
      ).toEqual({ status: 'RETRYING', delayMs: 10 });
    }
  });
});
