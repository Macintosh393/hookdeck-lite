// Integration tests for the `failed` listeners: the backstop for jobs that end in BullMQ's failed
// set without their processor writing a final state (docs/QUEUES.md#stalled-jobs). Real Postgres,
// Redis and BullMQ; the stalled case uses lock times of a few hundred milliseconds.
import { createWorkerConnection, QUEUE_DELIVERY, UnrecoverableError, Worker } from '@hdl/core';
import type { DeliveryJobData, FanoutJobData, Job, SafeHttpClient } from '@hdl/core';
import { createMockReceiver } from '@hdl/mock-receiver';
import type { MockReceiver } from '@hdl/mock-receiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  onDeliveryJobFailed,
  onFanoutJobFailed,
  STALLED_LIMIT_MESSAGE,
} from '../src/failed-listeners.js';
import {
  captureLogger,
  createTenant,
  createTestWorker,
  enqueueDeliveryJob,
  eventually,
  waitForTerminalDelivery,
} from './helpers.js';
import type { TestTenant, TestWorker } from './helpers.js';

describe('failed listeners', () => {
  const logs = captureLogger();
  let worker: TestWorker;
  let receiver: MockReceiver;
  let tenant: TestTenant;

  beforeAll(async () => {
    worker = await createTestWorker({}, { logger: logs.logger });
    receiver = await createMockReceiver({ log: false }).listen(0);
    tenant = await createTenant(worker.prisma, worker.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await worker.close();
    await receiver.close();
  });

  /** A PENDING delivery of a fanned-out event, without a job. */
  async function pendingDelivery(bucket: string) {
    const destination = await tenant.addDestination({ url: receiver.urlFor(bucket) });
    const event = await tenant.createEvent();
    await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
    return tenant.createDelivery(event, destination);
  }

  /** What BullMQ hands the listener: only the fields the listener reads. */
  const deliveryJob = (data: DeliveryJobData, attemptsMade: number, attempts: number) =>
    ({ data, attemptsMade, opts: { attempts } }) as Job<DeliveryJobData>;
  const fanoutJob = (data: FanoutJobData, attemptsMade: number, attempts: number) =>
    ({ data, attemptsMade, opts: { attempts } }) as Job<FanoutJobData>;

  describe('delivery jobs', () => {
    it('a job that stalls more often than maxStalledCount is failed by BullMQ and its delivery becomes DEAD with deadReason STALLED', async () => {
      // maxStalledCount 0: the first stall is already one too many. Checks run every 100 ms.
      const strict = await createTestWorker(
        {},
        { stalled: { lockDuration: 1000, stalledInterval: 100, maxStalledCount: 0 } },
      );
      // A second Worker without a processor stands in for a worker process that takes the job
      // and then dies: it locks the job for 150 ms and never renews the lock.
      const connection = createWorkerConnection(strict.env.REDIS_URL, strict.ctx.logger);
      const dying = new Worker(QUEUE_DELIVERY, null, {
        connection,
        prefix: strict.env.BULLMQ_PREFIX,
        lockDuration: 150,
      });
      try {
        const delivery = await pendingDelivery('stalled-out');
        // Keep the real Worker from taking the job first; pause() also stops its stalled check.
        await strict.app.deliveryWorker.pause();
        await enqueueDeliveryJob(strict.ctx, delivery);
        await dying.getNextJob('dying-worker');
        // From here on the real Worker checks for stalled jobs again. In BullMQ 6.7 the check
        // does not fail the job itself: it flags it and puts it back in the queue, and the
        // Worker that takes it next fails it without running the processor.
        await strict.app.deliveryWorker.resume();

        const done = await waitForTerminalDelivery(strict.prisma, delivery.id);

        expect(done).toMatchObject({
          status: 'DEAD',
          deadReason: 'STALLED',
          attemptCount: 0,
          nextAttemptAt: null,
        });
        expect(done.completedAt).toBeInstanceOf(Date);
        expect(done.attempts).toEqual([]);
        // The processor never ran, so nothing was sent.
        expect(receiver.requests('stalled-out')).toEqual([]);
        const job = await strict.ctx.deliveryQueue.getJob(delivery.id);
        expect(job?.failedReason).toBe(STALLED_LIMIT_MESSAGE);
      } finally {
        await dying.close();
        connection.disconnect();
        await strict.close();
      }
    });

    it('a delivery whose processor throws unexpectedly on every attempt ends DEAD instead of RETRYING forever', async () => {
      // The SSRF-safe client never throws; this stub stands for a bug in the processor.
      const broken: SafeHttpClient = {
        post: () => Promise.reject(new Error('unexpected bug in the processor')),
      };
      const buggy = await createTestWorker({}, { httpClient: broken, random: () => 0.5 });
      try {
        const delivery = await pendingDelivery('processor-bug');
        await enqueueDeliveryJob(buggy.ctx, delivery);

        const done = await waitForTerminalDelivery(buggy.prisma, delivery.id);

        // No attempt was recorded, so the reason is "the job died", not "retries exhausted".
        expect(done).toMatchObject({ status: 'DEAD', deadReason: 'STALLED', attemptCount: 0 });
        expect(done.attempts).toEqual([]);
        const job = await buggy.ctx.deliveryQueue.getJob(delivery.id);
        expect(job).toMatchObject({
          attemptsMade: buggy.env.DELIVERY_MAX_ATTEMPTS,
          failedReason: 'unexpected bug in the processor',
        });
      } finally {
        await buggy.close();
      }
    });

    it('does nothing after a failed attempt that BullMQ will retry', async () => {
      const delivery = await pendingDelivery('listener-retry');
      const data = { deliveryId: delivery.id, eventId: delivery.eventId, tenantId: tenant.id };

      await onDeliveryJobFailed(worker.ctx, deliveryJob(data, 1, 4), new Error('boom'));
      await onDeliveryJobFailed(worker.ctx, undefined, new Error('boom'));

      const after = await worker.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after).toMatchObject({ status: 'PENDING', deadReason: null });
    });

    it('never changes a delivery that is already terminal', async () => {
      const succeeded = await pendingDelivery('listener-terminal');
      const completedAt = new Date('2026-01-01T00:00:00Z');
      await worker.prisma.delivery.update({
        where: { id: succeeded.id },
        data: { status: 'SUCCEEDED', attemptCount: 1, completedAt },
      });
      const data = { deliveryId: succeeded.id, eventId: succeeded.eventId, tenantId: tenant.id };

      await onDeliveryJobFailed(
        worker.ctx,
        deliveryJob(data, 4, 4),
        new Error(STALLED_LIMIT_MESSAGE),
      );

      const after = await worker.prisma.delivery.findUniqueOrThrow({ where: { id: succeeded.id } });
      expect(after).toMatchObject({ status: 'SUCCEEDED', deadReason: null, completedAt });
    });

    it('uses RETRIES_EXHAUSTED when the attempts on record are used up', async () => {
      const delivery = await pendingDelivery('listener-exhausted');
      await worker.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'RETRYING', attemptCount: delivery.maxAttempts, nextAttemptAt: new Date() },
      });
      const data = { deliveryId: delivery.id, eventId: delivery.eventId, tenantId: tenant.id };

      await onDeliveryJobFailed(worker.ctx, deliveryJob(data, 4, 4), new Error('boom'));

      const after = await worker.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after).toMatchObject({
        status: 'DEAD',
        deadReason: 'RETRIES_EXHAUSTED',
        nextAttemptAt: null,
      });
    });

    it('logs and does not throw when Postgres cannot be reached; the sweeper covers it later', async () => {
      const delivery = await pendingDelivery('listener-db-down');
      const data = { deliveryId: delivery.id, eventId: delivery.eventId, tenantId: tenant.id };
      const offline = {
        ...worker.ctx,
        prisma: {
          delivery: { findUnique: () => Promise.reject(new Error('Postgres is down')) },
        } as unknown as typeof worker.ctx.prisma,
      };

      await expect(
        onDeliveryJobFailed(offline, deliveryJob(data, 4, 4), new Error('boom')),
      ).resolves.toBeUndefined();

      expect(
        logs
          .lines()
          .some(
            (line) =>
              line.msg === 'Could not mark the delivery DEAD; the sweeper will' &&
              line.deliveryId === delivery.id,
          ),
      ).toBe(true);
    });
  });

  describe('fan-out jobs', () => {
    it('marks the event FAILED with the reason when the job fails for the last time', async () => {
      const event = await tenant.createEvent();
      const data = { eventId: event.id, tenantId: tenant.id };

      // After attempt 1 of 5 BullMQ retries: nothing happens.
      await onFanoutJobFailed(worker.ctx, fanoutJob(data, 1, 5), new Error('Postgres is down'));
      const during = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(during.status).toBe('RECEIVED');

      await onFanoutJobFailed(worker.ctx, fanoutJob(data, 5, 5), new Error('x'.repeat(2000)));

      const after = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('FAILED');
      // The reason is cut to a length that fits a log line and a dashboard cell.
      expect(after.failureReason).toBe('x'.repeat(500));
    });

    it('leaves an event alone that was fanned out meanwhile', async () => {
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
      const data = { eventId: event.id, tenantId: tenant.id };

      await onFanoutJobFailed(worker.ctx, fanoutJob(data, 1, 5), new UnrecoverableError('late'));

      const after = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(after).toMatchObject({ status: 'FANNED_OUT', failureReason: null });
    });

    it('a poison payload fails the fan-out job; the listener is wired to the Worker', async () => {
      // Ingestion only stores valid JSON. Written by hand, such a body makes the processor throw.
      const event = await tenant.createEvent({ body: '{not json' });
      const failures: string[] = [];
      worker.app.fanoutWorker.on('failed', (job, error) => {
        if (job?.data.eventId === event.id) failures.push(error.name);
      });

      await worker.ctx.fanoutQueue.add(
        'fanout.event',
        { eventId: event.id, tenantId: tenant.id },
        // One attempt instead of five, so the test does not wait for seconds of backoff.
        { jobId: event.id, attempts: 1 },
      );

      const after = await eventually(async () => {
        const row = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        return row.status === 'FAILED' ? row : null;
      });
      expect(after.failureReason).toMatch(/JSON/);
      expect(failures).toEqual(['SyntaxError']);
    });
  });
});
