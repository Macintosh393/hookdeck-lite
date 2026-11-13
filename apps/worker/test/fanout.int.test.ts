// Integration tests for the fan-out processor against the real Postgres and Redis.
// Covers AC5.1–AC5.4 and AC6.3 (docs/PRD.md) and sequence diagram 2 of docs/ARCHITECTURE.md.
import { createApiSubscriberConnection, createStreamSubscriber } from '@hdl/core';
import type { FanoutJobData, Job } from '@hdl/core';
import { createMockReceiver } from '@hdl/mock-receiver';
import type { MockReceiver } from '@hdl/mock-receiver';
import type { StreamMessage } from '@hdl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processFanout } from '../src/fanout/fanout.processor.js';
import {
  captureLogger,
  createTenant,
  createTestWorker,
  deliveriesOf,
  enqueueEvent,
  eventually,
} from './helpers.js';
import type { TestTenant, TestWorker } from './helpers.js';

describe('fan-out processor', () => {
  const logs = captureLogger();
  let worker: TestWorker;
  let receiver: MockReceiver;

  beforeAll(async () => {
    worker = await createTestWorker({}, { logger: logs.logger });
    receiver = await createMockReceiver({ log: false }).listen(0);
  });

  afterAll(async () => {
    await worker.close();
    await receiver.close();
  });

  /** Each test gets its own tenant, so its events and connections are its own. */
  async function withTenant(run: (tenant: TestTenant) => Promise<void>): Promise<void> {
    const tenant = await createTenant(worker.prisma, worker.env);
    try {
      await run(tenant);
    } finally {
      await tenant.remove();
    }
  }

  const fannedOut = (eventId: string) =>
    eventually(async () => {
      const event = await worker.prisma.event.findUnique({ where: { id: eventId } });
      return event?.status === 'FANNED_OUT' ? event : null;
    });

  /** A stand-in for the BullMQ job: the processor reads only `data`. */
  const jobFor = (data: FanoutJobData) => ({ data }) as Job<FanoutJobData>;

  it('AC5.1 an event with N matching connections creates N deliveries and becomes FANNED_OUT with deliveryCount = N', async () => {
    await withTenant(async (tenant) => {
      const a = await tenant.addDestination({ url: receiver.urlFor('fan-a') });
      const b = await tenant.addDestination({ url: receiver.urlFor('fan-b') });
      const c = await tenant.addDestination({
        url: receiver.urlFor('fan-c'),
        filter: { body: { type: 'order.created' } },
      });
      const event = await tenant.createEvent();

      await enqueueEvent(worker.ctx, event);
      const after = await fannedOut(event.id);

      expect(after.deliveryCount).toBe(3);
      expect(after.filteredCount).toBe(0);
      expect(after.fannedOutAt).toBeInstanceOf(Date);

      const deliveries = await deliveriesOf(worker.prisma, event.id);
      expect(deliveries).toHaveLength(3);
      expect(deliveries.map((d) => d.destinationId).sort()).toEqual([a.id, b.id, c.id].sort());
      for (const delivery of deliveries) {
        expect(delivery).toMatchObject({
          tenantId: tenant.id,
          trigger: 'EVENT',
          replayOfId: null,
          maxAttempts: worker.env.DELIVERY_MAX_ATTEMPTS,
        });
      }
      // The connection each delivery came from is recorded.
      expect(deliveries.map((d) => d.connectionId).sort()).toEqual(
        [a.connectionId, b.connectionId, c.connectionId].sort(),
      );
    });
  });

  it('AC5.1 a delivery job is enqueued for each delivery, with jobId = Delivery.id', async () => {
    await withTenant(async (tenant) => {
      // A slow receiver keeps the job in the queue long enough to look at it.
      await tenant.addDestination({ url: `${receiver.urlFor('fan-slow')}?delayMs=400` });
      const event = await tenant.createEvent();

      await enqueueEvent(worker.ctx, event);
      await fannedOut(event.id);

      const [delivery] = await deliveriesOf(worker.prisma, event.id);
      const job = await eventually(() => worker.ctx.deliveryQueue.getJob(delivery!.id));
      expect(job.name).toBe('delivery.attempt');
      expect(job.data).toEqual({
        deliveryId: delivery!.id,
        eventId: event.id,
        tenantId: tenant.id,
      });
      expect(job.opts.attempts).toBe(worker.env.DELIVERY_MAX_ATTEMPTS);
      expect(job.opts.backoff).toEqual({ type: 'custom' });
    });
  });

  it('AC5.2 disabled connections and connections to disabled destinations create no delivery', async () => {
    await withTenant(async (tenant) => {
      const live = await tenant.addDestination({ url: receiver.urlFor('fan-live') });
      await tenant.addDestination({ url: receiver.urlFor('fan-off'), connectionEnabled: false });
      await tenant.addDestination({ url: receiver.urlFor('fan-dest-off'), enabled: false });
      const event = await tenant.createEvent();

      await enqueueEvent(worker.ctx, event);
      const after = await fannedOut(event.id);

      const deliveries = await deliveriesOf(worker.prisma, event.id);
      expect(deliveries.map((d) => d.destinationId)).toEqual([live.id]);
      expect(after.deliveryCount).toBe(1);
      // Disabled connections are not "filtered": the count is about filters only.
      expect(after.filteredCount).toBe(0);
    });
  });

  it('AC5.3 running the fan-out job twice for one event creates each delivery once', async () => {
    await withTenant(async (tenant) => {
      await tenant.addDestination({ url: receiver.urlFor('fan-twice-a') });
      await tenant.addDestination({ url: receiver.urlFor('fan-twice-b') });
      const event = await tenant.createEvent();
      const job = jobFor({ eventId: event.id, tenantId: tenant.id });

      // Two runs at the same moment (the api and the sweeper both enqueued), then a third later.
      await Promise.all([processFanout(worker.ctx, job), processFanout(worker.ctx, job)]);
      await processFanout(worker.ctx, job);

      expect(await deliveriesOf(worker.prisma, event.id)).toHaveLength(2);
      const after = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(after).toMatchObject({ status: 'FANNED_OUT', deliveryCount: 2 });
    });
  });

  it('AC5.3 enqueueing the same event twice runs one job (jobId = Event.id)', async () => {
    await withTenant(async (tenant) => {
      await tenant.addDestination({ url: receiver.urlFor('fan-dup') });
      const event = await tenant.createEvent();

      await Promise.all([enqueueEvent(worker.ctx, event), enqueueEvent(worker.ctx, event)]);
      await fannedOut(event.id);

      expect(await deliveriesOf(worker.prisma, event.id)).toHaveLength(1);
    });
  });

  it('AC5.4 an event with zero matching connections becomes FANNED_OUT with deliveryCount = 0', async () => {
    await withTenant(async (tenant) => {
      const event = await tenant.createEvent(); // the source has no connection at all

      await enqueueEvent(worker.ctx, event);
      const after = await fannedOut(event.id);

      expect(after).toMatchObject({ deliveryCount: 0, filteredCount: 0 });
      expect(await deliveriesOf(worker.prisma, event.id)).toEqual([]);
    });
  });

  it('routes by filter on body, headers and query, and counts the connections that did not match', async () => {
    await withTenant(async (tenant) => {
      const paid = await tenant.addDestination({
        url: receiver.urlFor('fan-paid'),
        filter: { body: { type: 'order.created', 'data.amount': { $gte: 100 } } },
      });
      await tenant.addDestination({
        url: receiver.urlFor('fan-refunds'),
        filter: { body: { type: 'order.refunded' } },
      });
      const prod = await tenant.addDestination({
        url: receiver.urlFor('fan-prod'),
        filter: { headers: { 'x-environment': 'production' }, query: { region: 'eu' } },
      });
      await tenant.addDestination({
        url: receiver.urlFor('fan-staging'),
        filter: { headers: { 'x-environment': 'staging' } },
      });
      const event = await tenant.createEvent({
        headers: { 'content-type': 'application/json', 'x-environment': 'production' },
        query: { region: 'eu' },
      });

      await enqueueEvent(worker.ctx, event);
      const after = await fannedOut(event.id);

      expect(after).toMatchObject({ deliveryCount: 2, filteredCount: 2 });
      const deliveries = await deliveriesOf(worker.prisma, event.id);
      expect(deliveries.map((d) => d.destinationId).sort()).toEqual([paid.id, prod.id].sort());
    });
  });

  it('AC6.3 a stored filter that is invalid is treated as no match and logged; fan-out does not throw', async () => {
    await withTenant(async (tenant) => {
      const good = await tenant.addDestination({ url: receiver.urlFor('fan-good') });
      // Written straight into the database, past the api's validation.
      const unknownOperator = await tenant.addDestination({
        url: receiver.urlFor('fan-bad-1'),
        filter: { body: { type: { $regex: '.*' } } },
      });
      await tenant.addDestination({
        url: receiver.urlFor('fan-bad-2'),
        filter: 'not an object',
      });
      const event = await tenant.createEvent();

      await enqueueEvent(worker.ctx, event);
      const after = await fannedOut(event.id);

      expect(after).toMatchObject({ deliveryCount: 1, filteredCount: 2 });
      const deliveries = await deliveriesOf(worker.prisma, event.id);
      expect(deliveries.map((d) => d.destinationId)).toEqual([good.id]);
      expect(
        logs
          .lines()
          .some(
            (line) =>
              line.msg === 'Stored filter is invalid; treating it as no match' &&
              line.connectionId === unknownOperator.connectionId &&
              line.eventId === event.id,
          ),
      ).toBe(true);
    });
  });

  it('leaves an event alone that is not RECEIVED, or that does not exist', async () => {
    await withTenant(async (tenant) => {
      await tenant.addDestination({ url: receiver.urlFor('fan-skip') });
      const event = await tenant.createEvent();
      await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FAILED' } });

      await processFanout(worker.ctx, jobFor({ eventId: event.id, tenantId: tenant.id }));
      await processFanout(
        worker.ctx,
        jobFor({ eventId: '019a7b00-0000-7000-8000-00000000dead', tenantId: tenant.id }),
      );

      expect(await deliveriesOf(worker.prisma, event.id)).toEqual([]);
      const after = await worker.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.status).toBe('FAILED');
    });
  });

  it('publishes event.fanned_out and one delivery.created per delivery on the tenant’s channel', async () => {
    await withTenant(async (tenant) => {
      const subscriberConnection = createApiSubscriberConnection(worker.env.REDIS_URL, logs.logger);
      const subscriber = createStreamSubscriber(subscriberConnection, logs.logger);
      const seen: StreamMessage[] = [];
      await subscriber.subscribe(tenant.id, (message) => seen.push(message));
      try {
        const destination = await tenant.addDestination({ url: receiver.urlFor('fan-stream') });
        await tenant.addDestination({
          url: receiver.urlFor('fan-stream-filtered'),
          filter: { body: { type: 'something.else' } },
        });
        const event = await tenant.createEvent();

        await enqueueEvent(worker.ctx, event);
        await eventually(() => seen.some((m) => m.type === 'delivery.created'));

        const [delivery] = await deliveriesOf(worker.prisma, event.id);
        expect(seen.find((m) => m.type === 'event.fanned_out')).toMatchObject({
          data: { eventId: event.id, deliveryCount: 1, filteredCount: 1 },
        });
        expect(seen.find((m) => m.type === 'delivery.created')).toMatchObject({
          data: {
            deliveryId: delivery!.id,
            eventId: event.id,
            destinationId: destination.id,
            trigger: 'EVENT',
            replayOfId: null,
          },
        });
      } finally {
        await subscriber.close();
        subscriberConnection.disconnect();
      }
    });
  });
});
