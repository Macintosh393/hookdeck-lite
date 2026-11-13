// Integration tests for the sweeper against the real Postgres and Redis: AC11.1–AC11.3
// (docs/PRD.md), the "job in the failed set → row marked terminal" rule, and the properties in
// docs/QUEUES.md#sweeper. Tests call sweepOnce() with a clock set in the future, so rows count as
// stuck without anyone waiting 30 seconds.
import {
  createWorkerConnection,
  enqueueDelivery,
  enqueueFanout,
  QUEUE_FANOUT,
  UnrecoverableError,
  Worker,
} from '@hdl/core';
import { createMockReceiver } from '@hdl/mock-receiver';
import type { MockReceiver } from '@hdl/mock-receiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerContext } from '../src/context.js';
import { startSweeper, sweepOnce } from '../src/sweeper.js';
import type { SweepResult } from '../src/sweeper.js';
import {
  captureLogger,
  createTenant,
  createTestWorker,
  deliveriesOf,
  eventually,
  waitForTerminalDelivery,
} from './helpers.js';
import type { TestTenant, TestWorker } from './helpers.js';

describe('sweeper', () => {
  const logs = captureLogger();
  let worker: TestWorker;
  let receiver: MockReceiver;
  let tenant: TestTenant;

  /**
   * One pass at a moment when everything created by now is older than SWEEPER_STUCK_AFTER_MS.
   * Limited to one tenant: the test files share a database, and an unscoped pass would enqueue
   * (and this worker would deliver) the rows other files are working with.
   */
  const sweepLater = (ctx: WorkerContext, tenantId: string = tenant.id): Promise<SweepResult> =>
    sweepOnce(ctx, {
      now: new Date(Date.now() + worker.env.SWEEPER_STUCK_AFTER_MS + 60_000),
      tenantId,
    });

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

  describe('events', () => {
    it('AC11.1 an event left RECEIVED with no job is re-enqueued and delivered', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('swept-event') });
      // Stored by ingestion while Redis was down: the row exists, the job does not.
      const event = await tenant.createEvent();
      expect(await worker.ctx.fanoutQueue.getJob(event.id)).toBeUndefined();

      const result = await sweepLater(worker.ctx);

      expect(result.events.enqueued).toBeGreaterThanOrEqual(1);
      const delivery = await eventually(async () => {
        const [first] = (await deliveriesOf(worker.prisma, event.id)).filter(
          (d) => d.destinationId === destination.id,
        );
        return first?.status === 'SUCCEEDED' ? first : null;
      });
      expect(delivery.attempts).toHaveLength(1);
      expect(receiver.requests('swept-event')).toHaveLength(1);
      const after = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('FANNED_OUT');
    });

    it('does not touch an event that is younger than SWEEPER_STUCK_AFTER_MS', async () => {
      const event = await tenant.createEvent();

      // The real "now": the event is a few ms old.
      await sweepOnce(worker.ctx, { now: new Date(), tenantId: tenant.id });

      expect(await worker.ctx.fanoutQueue.getJob(event.id)).toBeUndefined();
      const after = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('RECEIVED');
      // Clean up so later sweeps in this file do not pick it up.
      await worker.prisma.event.delete({ where: { id: event.id } });
    });

    it('AC11.3 sweeping an event that already has a job changes nothing', async () => {
      const idle = await createTestWorker(); // its Workers are closed below: jobs stay put
      await Promise.all([idle.app.fanoutWorker.close(), idle.app.deliveryWorker.close()]);
      const own = await createTenant(idle.prisma, idle.env);
      try {
        const event = await own.createEvent();
        await enqueueFanout(idle.ctx.fanoutQueue, { eventId: event.id, tenantId: own.id });
        const before = await idle.ctx.fanoutQueue.getJobCounts('waiting', 'delayed', 'active');

        const first = await sweepLater(idle.ctx, own.id);
        const second = await sweepLater(idle.ctx, own.id); // idempotent: twice is the same as once

        expect(first.events).toMatchObject({ enqueued: 0, inProgress: 1, markedTerminal: 0 });
        expect(second.events).toMatchObject({ enqueued: 0, inProgress: 1, markedTerminal: 0 });
        expect(await idle.ctx.fanoutQueue.getJobCounts('waiting', 'delayed', 'active')).toEqual(
          before,
        );
        const after = await idle.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        expect(after.status).toBe('RECEIVED');
      } finally {
        await own.remove();
        await idle.close();
      }
    });

    it('an event whose fan-out job is in the failed set is marked FAILED with the job’s reason', async () => {
      // The file's worker would run the job at once and complete it. So build the failed job on
      // queues nobody consumes, and fail it by hand through a Worker without a processor.
      const idle = await createTestWorker();
      await Promise.all([idle.app.fanoutWorker.close(), idle.app.deliveryWorker.close()]);
      const own = await createTenant(idle.prisma, idle.env);
      const connection = createWorkerConnection(idle.env.REDIS_URL, idle.ctx.logger);
      const fetcher = new Worker(QUEUE_FANOUT, null, {
        connection,
        prefix: idle.env.BULLMQ_PREFIX,
      });
      try {
        const event = await own.createEvent();
        await enqueueFanout(idle.ctx.fanoutQueue, { eventId: event.id, tenantId: own.id });
        // Take the job as a Worker would (it becomes active), then fail it for good. An
        // UnrecoverableError skips the remaining attempts, so the job lands in the failed set
        // now instead of after five real retries.
        const token = 'sweeper-test';
        const active = await fetcher.getNextJob(token);
        await active.moveToFailed(new UnrecoverableError('poison payload'), token, false);
        expect(await active.getState()).toBe('failed');

        const result = await sweepLater(idle.ctx, own.id);

        expect(result.events).toMatchObject({ enqueued: 0, markedTerminal: 1 });
        const after = await idle.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        expect(after).toMatchObject({ status: 'FAILED', failureReason: 'poison payload' });
      } finally {
        await fetcher.close();
        connection.disconnect();
        await own.remove();
        await idle.close();
      }
    });
  });

  describe('deliveries', () => {
    it('AC11.2 a delivery left PENDING with no job is re-enqueued and delivered', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('swept-pending') });
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
      // A crash between the fan-out commit and addBulk: the row exists, the job does not.
      const delivery = await tenant.createDelivery(event, destination);

      const result = await sweepLater(worker.ctx);

      expect(result.deliveries.enqueued).toBeGreaterThanOrEqual(1);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);
      expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
      expect(receiver.requests('swept-pending')).toHaveLength(1);
    });

    it('AC11.2 a delivery left RETRYING past its nextAttemptAt with no job is re-enqueued and continues its count', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('swept-retrying') });
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
      // Redis lost its data: two attempts are on record, the delayed job is gone.
      const delivery = await tenant.createDelivery(event, destination, {
        status: 'RETRYING',
        attemptCount: 2,
        nextAttemptAt: new Date(Date.now() - 1000),
      });

      await sweepLater(worker.ctx);

      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);
      expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 3 });
      expect(done.attempts.map((a) => a.attemptNumber)).toEqual([3]);
      expect(receiver.requests('swept-retrying')[0]?.headers['x-hdl-attempt']).toBe('3');
    });

    it('does not touch a RETRYING delivery whose next attempt is still in the future', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('not-yet') });
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
      const delivery = await tenant.createDelivery(event, destination, {
        status: 'RETRYING',
        attemptCount: 1,
        // Far enough ahead to still be in the future for a sweep that runs "later".
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      });

      await sweepLater(worker.ctx);

      expect(await worker.ctx.deliveryQueue.getJob(delivery.id)).toBeUndefined();
      expect(receiver.requests('not-yet')).toEqual([]);
      await worker.prisma.delivery.delete({ where: { id: delivery.id } });
    });

    it('AC11.3 sweeping a delivery that already has a job changes nothing', async () => {
      const idle = await createTestWorker();
      await Promise.all([idle.app.fanoutWorker.close(), idle.app.deliveryWorker.close()]);
      const own = await createTenant(idle.prisma, idle.env);
      try {
        const destination = await own.addDestination({ url: receiver.urlFor('has-job') });
        const event = await own.createEvent();
        await idle.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
        const delivery = await own.createDelivery(event, destination);
        await enqueueDelivery(
          idle.ctx.deliveryQueue,
          { deliveryId: delivery.id, eventId: event.id, tenantId: own.id },
          delivery.maxAttempts,
        );

        const first = await sweepLater(idle.ctx, own.id);
        const second = await sweepLater(idle.ctx, own.id);

        expect(first.deliveries).toMatchObject({ enqueued: 0, inProgress: 1, markedTerminal: 0 });
        expect(second.deliveries).toMatchObject({ enqueued: 0, inProgress: 1, markedTerminal: 0 });
        expect(await idle.ctx.deliveryQueue.getJobCounts('waiting')).toEqual({ waiting: 1 });
        const after = await idle.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
        expect(after).toMatchObject({ status: 'PENDING', attemptCount: 0 });
        expect(receiver.requests('has-job')).toEqual([]);
      } finally {
        await own.remove();
        await idle.close();
      }
    });

    it('a delivery whose job is in the failed set is marked DEAD: STALLED, or RETRIES_EXHAUSTED when its attempts are used up', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('failed-job') });
      receiver.setScenario('failed-job', { default: { status: 404 } });
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });

      // Get two real jobs into BullMQ's failed set: each delivery gets a 404 and goes DEAD.
      const stalled = await tenant.createDelivery(event, destination);
      const exhausted = await tenant.createDelivery(event, destination);
      for (const delivery of [stalled, exhausted]) {
        await enqueueDelivery(
          worker.ctx.deliveryQueue,
          { deliveryId: delivery.id, eventId: event.id, tenantId: tenant.id },
          delivery.maxAttempts,
        );
        await waitForTerminalDelivery(worker.prisma, delivery.id);
        const job = await eventually(() => worker.ctx.deliveryQueue.getJob(delivery.id));
        await eventually(async () => (await job.getState()) === 'failed');
      }
      // Now make the rows look as if the processor never wrote a final state: the job stalled
      // out, or kept throwing, and the failed listener could not reach Postgres.
      await worker.prisma.delivery.update({
        where: { id: stalled.id },
        data: {
          status: 'RETRYING',
          attemptCount: 1,
          deadReason: null,
          completedAt: null,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });
      await worker.prisma.delivery.update({
        where: { id: exhausted.id },
        data: {
          status: 'RETRYING',
          attemptCount: 4,
          deadReason: null,
          completedAt: null,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      const result = await sweepLater(worker.ctx);

      expect(result.deliveries.markedTerminal).toBeGreaterThanOrEqual(2);
      const stalledAfter = await worker.prisma.delivery.findUniqueOrThrow({
        where: { id: stalled.id },
      });
      const exhaustedAfter = await worker.prisma.delivery.findUniqueOrThrow({
        where: { id: exhausted.id },
      });
      expect(stalledAfter).toMatchObject({
        status: 'DEAD',
        deadReason: 'STALLED',
        nextAttemptAt: null,
      });
      expect(exhaustedAfter).toMatchObject({ status: 'DEAD', deadReason: 'RETRIES_EXHAUSTED' });
      expect(stalledAfter.completedAt).toBeInstanceOf(Date);
      // No new request was sent: the sweeper marks, it does not retry a failed job.
      expect(receiver.requests('failed-job')).toHaveLength(2);
    });

    it('logs a warning for a completed job whose delivery is not terminal, and changes nothing', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('inconsistent') });
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
      const delivery = await tenant.createDelivery(event, destination);
      await enqueueDelivery(
        worker.ctx.deliveryQueue,
        { deliveryId: delivery.id, eventId: event.id, tenantId: tenant.id },
        delivery.maxAttempts,
      );
      await waitForTerminalDelivery(worker.prisma, delivery.id);
      const job = await eventually(() => worker.ctx.deliveryQueue.getJob(delivery.id));
      await eventually(async () => (await job.getState()) === 'completed');
      // Should never happen. Force it, to see that the sweeper reports instead of guessing.
      await worker.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'PENDING', completedAt: null },
      });

      const result = await sweepLater(worker.ctx);

      expect(result.deliveries.inconsistent).toBeGreaterThanOrEqual(1);
      expect(
        logs
          .lines()
          .some(
            (line) =>
              line.msg === 'Delivery job completed but the delivery is not terminal' &&
              line.deliveryId === delivery.id,
          ),
      ).toBe(true);
      expect(receiver.requests('inconsistent')).toHaveLength(1);
      await worker.prisma.delivery.delete({ where: { id: delivery.id } });
    });
  });

  describe('as an interval', () => {
    it('runs by itself every SWEEPER_INTERVAL_MS and recovers a stuck event without anyone calling it', async () => {
      // The tenant comes first, so the interval can be limited to it (see sweepLater above).
      const own = await createTenant(worker.prisma, worker.env);
      const auto = await createTestWorker(
        { SWEEPER_INTERVAL_MS: '100', SWEEPER_STUCK_AFTER_MS: '50' },
        { runSweeper: true, sweepTenantId: own.id },
      );
      try {
        await own.addDestination({ url: receiver.urlFor('auto-swept') });
        const event = await own.createEvent(); // no job

        const [delivery] = await eventually(async () => {
          const all = await deliveriesOf(auto.prisma, event.id);
          return all.length === 1 && all[0]?.status === 'SUCCEEDED' ? all : null;
        });

        expect(delivery?.attempts).toHaveLength(1);
        expect(receiver.requests('auto-swept')).toHaveLength(1);
      } finally {
        await own.remove();
        await auto.close();
      }
    });

    it('is safe when Redis is down: the pass fails, is logged, and the next tick runs', async () => {
      const failing = captureLogger();
      let passes = 0;
      // A context whose queue cannot reach Redis: getJob rejects, as it does during an outage.
      const brokenCtx = {
        ...worker.ctx,
        logger: failing.logger,
        env: { ...worker.env, SWEEPER_INTERVAL_MS: 30, SWEEPER_STUCK_AFTER_MS: 1 },
        fanoutQueue: {
          getJob: () => {
            passes += 1;
            return Promise.reject(new Error('Connection is closed.'));
          },
        } as unknown as typeof worker.ctx.fanoutQueue,
      };
      const own = await createTenant(worker.prisma, worker.env);
      try {
        await own.createEvent({ receivedAt: new Date(Date.now() - 60_000) });

        const sweeper = startSweeper(brokenCtx, { tenantId: own.id });
        await eventually(() => passes >= 3);
        await sweeper.stop();

        const warnings = failing
          .lines()
          .filter((line) => line.msg === 'Sweeper pass failed; it will try again on the next tick');
        expect(warnings.length).toBeGreaterThanOrEqual(3);
        expect(warnings[0]?.err).toBe('Connection is closed.');
      } finally {
        await own.remove();
      }
    });
  });
});
