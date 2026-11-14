// Unit tests for the decisions of the failed listeners: when a failure is final, and which dead
// reason it gets. The listeners themselves are tested in test/failed-listeners.int.test.ts.
import { UnrecoverableError } from '@hdl/core';
import { describe, expect, it } from 'vitest';
import {
  deadReasonForFailedJob,
  isFinalFailure,
  STALLED_LIMIT_MESSAGE,
} from './failed-listeners.js';

const job = (attemptsMade: number, attempts: number | undefined) => ({
  attemptsMade,
  opts: attempts === undefined ? {} : { attempts },
});

describe('isFinalFailure', () => {
  it('is false for a failed attempt that BullMQ will retry', () => {
    // `failed` fires after every attempt (U8): 1 of 3 and 2 of 3 are not the end.
    expect(isFinalFailure(job(1, 3), new Error('boom'))).toBe(false);
    expect(isFinalFailure(job(2, 3), new Error('boom'))).toBe(false);
  });

  it('is true when the attempts are used up', () => {
    expect(isFinalFailure(job(3, 3), new Error('boom'))).toBe(true);
    // A job without an `attempts` option has one attempt.
    expect(isFinalFailure(job(1, undefined), new Error('boom'))).toBe(true);
  });

  it('is true for an UnrecoverableError, whatever attemptsMade says', () => {
    expect(
      isFinalFailure(job(1, 10), new UnrecoverableError('Destination responded with 404.')),
    ).toBe(true);
    // A copy of the class from a second bullmq instance still counts: the name is checked too.
    const foreign = Object.assign(new Error('gone'), { name: 'UnrecoverableError' });
    expect(isFinalFailure(job(1, 10), foreign)).toBe(true);
  });

  it('is true for the stalled-limit failure, which BullMQ raises without running the processor', () => {
    expect(isFinalFailure(job(0, 10), new Error(STALLED_LIMIT_MESSAGE))).toBe(true);
    expect(isFinalFailure(undefined, new Error(STALLED_LIMIT_MESSAGE))).toBe(true);
  });

  it('is false without a job when the error itself does not say it is final', () => {
    expect(isFinalFailure(undefined, new Error('boom'))).toBe(false);
  });
});

describe('deadReasonForFailedJob', () => {
  it('is STALLED while attempts were left, RETRIES_EXHAUSTED once they are used up', () => {
    expect(deadReasonForFailedJob({ attemptCount: 0, maxAttempts: 4 })).toBe('STALLED');
    expect(deadReasonForFailedJob({ attemptCount: 3, maxAttempts: 4 })).toBe('STALLED');
    expect(deadReasonForFailedJob({ attemptCount: 4, maxAttempts: 4 })).toBe('RETRIES_EXHAUSTED');
    expect(deadReasonForFailedJob({ attemptCount: 5, maxAttempts: 4 })).toBe('RETRIES_EXHAUSTED');
  });
});
