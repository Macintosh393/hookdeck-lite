// Factories for the two BullMQ queues and the options their jobs are added with.
// Pipeline position: between ingest and fan-out (`fanout` queue) and between fan-out and
// delivery (`delivery` queue). Spec: docs/QUEUES.md#job-options
import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_DELIVERY_ATTEMPT, JOB_FANOUT_EVENT, QUEUE_DELIVERY, QUEUE_FANOUT } from './types.js';
import type { DeliveryJobData, FanoutJobData } from './types.js';

export type FanoutQueue = Queue<FanoutJobData, void, typeof JOB_FANOUT_EVENT>;
export type DeliveryQueue = Queue<DeliveryJobData, void, typeof JOB_DELIVERY_ATTEMPT>;

export interface QueueFactoryOptions {
  /** An ioredis connection from redis.ts. The queue shares it and never closes it. */
  connection: Redis;
  /** BULLMQ_PREFIX. Every Redis key of the queue starts with it. */
  prefix: string;
  /**
   * Set by the api. By default `queue.add()` first waits for the Redis connection to become
   * ready, which never happens while Redis is down, so the HTTP request would hang. With this
   * flag the add is sent straight away and fails fast. See docs/QUEUES.md#redis-connections
   */
  skipWaitingForReady?: boolean;
}

// fanout: a failure here is a bug or an outage, so BullMQ's built-in backoff is enough.
export const fanoutJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 }, // 1 s, 2 s, 4 s, 8 s, each jittered
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600, count: 1000 }, // age is in seconds
};

/** delivery: the worker's custom backoff strategy reads the delay from the error the processor throws. */
export function buildDeliveryJobOptions(maxAttempts: number): JobsOptions {
  return {
    attempts: maxAttempts,
    backoff: { type: 'custom' },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600, count: 5000 },
  };
}

/**
 * BullMQ repeats its connection's `error` events on the queue object. An `error` event that
 * nobody listens to crashes a Node process, so every queue gets a listener. It does nothing:
 * redis.ts already logs the connection's state changes, once.
 */
function ignoreConnectionErrors<T extends { on(event: 'error', listener: () => void): unknown }>(
  queue: T,
): T {
  queue.on('error', () => {});
  return queue;
}

export function createFanoutQueue(options: QueueFactoryOptions): FanoutQueue {
  return ignoreConnectionErrors(
    new Queue<FanoutJobData, void, typeof JOB_FANOUT_EVENT>(QUEUE_FANOUT, {
      connection: options.connection,
      prefix: options.prefix,
      skipWaitingForReady: options.skipWaitingForReady ?? false,
    }),
  );
}

export function createDeliveryQueue(options: QueueFactoryOptions): DeliveryQueue {
  return ignoreConnectionErrors(
    new Queue<DeliveryJobData, void, typeof JOB_DELIVERY_ATTEMPT>(QUEUE_DELIVERY, {
      connection: options.connection,
      prefix: options.prefix,
      skipWaitingForReady: options.skipWaitingForReady ?? false,
    }),
  );
}

/** Adds the job that turns one Event into Deliveries. Safe to call more than once per event. */
export async function enqueueFanout(queue: FanoutQueue, data: FanoutJobData): Promise<void> {
  // LEARN: jobId = event.id makes the enqueue idempotent. BullMQ ignores an add whose id already
  // exists in the queue, so the api and the sweeper can both enqueue the same event blindly.
  // It deduplicates enqueues only, not processing. See docs/learning/bullmq-101.md#job-ids
  await queue.add(JOB_FANOUT_EVENT, data, { ...fanoutJobOptions, jobId: data.eventId });
}
