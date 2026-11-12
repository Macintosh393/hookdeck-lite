// Integration tests for the queue factories against the real Redis: job ids, job options, and
// the fail-fast behaviour the api depends on when Redis is down.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDeliveryJobOptions,
  createDeliveryQueue,
  createFanoutQueue,
  enqueueFanout,
} from '../src/queues/factories.js';
import type { DeliveryQueue, FanoutQueue } from '../src/queues/factories.js';
import { JOB_DELIVERY_ATTEMPT, JOB_FANOUT_EVENT } from '../src/queues/types.js';
import { createApiProducerConnection, waitForRedisReady } from '../src/redis.js';
import { captureLogger, closedPortRedisUrl, redisUrl } from './helpers.js';

// A unique prefix per test file keeps parallel test files out of each other's queues.
const prefix = `${process.env.BULLMQ_PREFIX ?? 'hdl-test'}-${randomUUID().slice(0, 8)}`;

describe('queue factories (real Redis)', () => {
  const { logger } = captureLogger();
  let connection: Redis;
  let fanoutQueue: FanoutQueue;
  let deliveryQueue: DeliveryQueue;

  beforeAll(async () => {
    // The api's fail-fast connection, because that is the one the api's queues run on.
    connection = createApiProducerConnection(redisUrl, logger);
    expect(await waitForRedisReady(connection, 5000)).toBe(true);
    fanoutQueue = createFanoutQueue({ connection, prefix, skipWaitingForReady: true });
    deliveryQueue = createDeliveryQueue({ connection, prefix, skipWaitingForReady: true });
  });

  afterAll(async () => {
    await fanoutQueue.obliterate({ force: true });
    await deliveryQueue.obliterate({ force: true });
    await fanoutQueue.close();
    await deliveryQueue.close();
    await connection.quit();
  });

  it('enqueueFanout adds a fanout.event job whose id is the event id', async () => {
    const data = { eventId: randomUUID(), tenantId: randomUUID() };

    await enqueueFanout(fanoutQueue, data);

    const job = await fanoutQueue.getJob(data.eventId);
    expect(job?.name).toBe(JOB_FANOUT_EVENT);
    expect(job?.data).toEqual(data);
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1000, jitter: 0.5 });
    expect(await job?.getState()).toBe('waiting');
  });

  it('enqueueing the same event twice leaves one job (jobId idempotency)', async () => {
    const data = { eventId: randomUUID(), tenantId: randomUUID() };
    const before = await fanoutQueue.getWaitingCount();

    await enqueueFanout(fanoutQueue, data);
    await enqueueFanout(fanoutQueue, data);
    await enqueueFanout(fanoutQueue, { ...data, tenantId: 'a-later-add-is-ignored' });

    expect(await fanoutQueue.getWaitingCount()).toBe(before + 1);
    expect((await fanoutQueue.getJob(data.eventId))?.data).toEqual(data);
  });

  it('uses the configured prefix for every key, and the queue names of the spec', async () => {
    await enqueueFanout(fanoutQueue, { eventId: randomUUID(), tenantId: randomUUID() });

    const keys = await connection.keys(`${prefix}:*`);
    // BullMQ's key layout is {prefix}:{queue name}:{...}.
    expect(keys.some((key) => key.startsWith(`${prefix}:fanout:`))).toBe(true);
    expect(keys.filter((key) => !/^[^:]+:(fanout|delivery):/.test(key))).toEqual([]);
    expect(fanoutQueue.name).toBe('fanout');
    expect(deliveryQueue.name).toBe('delivery');
  });

  it('the delivery queue accepts a delivery.attempt job with the delivery options', async () => {
    const data = { deliveryId: randomUUID(), eventId: randomUUID(), tenantId: randomUUID() };

    await deliveryQueue.add(JOB_DELIVERY_ATTEMPT, data, {
      ...buildDeliveryJobOptions(4),
      jobId: data.deliveryId,
    });

    const job = await deliveryQueue.getJob(data.deliveryId);
    expect(job?.data).toEqual(data);
    expect(job?.opts.attempts).toBe(4);
    expect(job?.opts.backoff).toEqual({ type: 'custom' });
  });
});

describe('queue factories when Redis is unreachable', () => {
  it('enqueueFanout rejects quickly instead of hanging (skipWaitingForReady)', async () => {
    const { logger } = captureLogger();
    const connection = createApiProducerConnection(await closedPortRedisUrl(), logger);
    const queue = createFanoutQueue({ connection, prefix, skipWaitingForReady: true });
    // BullMQ reports connection problems on the queue too; without a listener they would be unhandled.
    queue.on('error', () => {});

    const startedAt = Date.now();
    await expect(
      enqueueFanout(queue, { eventId: randomUUID(), tenantId: randomUUID() }),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1000);

    await queue.close();
    connection.disconnect();
  });
});
