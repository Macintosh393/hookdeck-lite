// Unit tests for the parts of the queue contract that need no Redis: the names, the job options
// and the error class. They pin the values of docs/QUEUES.md, so a change there is a conscious one.
// Adding jobs for real is tested in test/queue-factories.int.test.ts.
import { describe, expect, it } from 'vitest';
import { buildDeliveryJobOptions, fanoutJobOptions } from './factories.js';
import {
  JOB_DELIVERY_ATTEMPT,
  JOB_FANOUT_EVENT,
  QUEUE_DELIVERY,
  QUEUE_FANOUT,
  RetryableDeliveryError,
} from './types.js';

describe('queue contract', () => {
  it('uses the canonical queue and job names', () => {
    expect([QUEUE_FANOUT, QUEUE_DELIVERY]).toEqual(['fanout', 'delivery']);
    expect([JOB_FANOUT_EVENT, JOB_DELIVERY_ATTEMPT]).toEqual(['fanout.event', 'delivery.attempt']);
  });

  it('fan-out jobs use BullMQ’s built-in exponential backoff: 5 attempts from 1 s, jittered', () => {
    expect(fanoutJobOptions).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { age: 86_400, count: 1000 },
    });
  });

  it('delivery jobs use the custom backoff strategy and take their attempts from the Delivery', () => {
    expect(buildDeliveryJobOptions(10)).toEqual({
      attempts: 10,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400, count: 5000 },
    });
    expect(buildDeliveryJobOptions(4).attempts).toBe(4);
  });

  it('RetryableDeliveryError carries the delay the processor computed', () => {
    const error = new RetryableDeliveryError('Destination responded with 503.', 1234);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RetryableDeliveryError');
    expect(error.message).toBe('Destination responded with 503.');
    expect(error.delayMs).toBe(1234);
  });
});
