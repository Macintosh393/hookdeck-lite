// Integration tests for replay against the real Postgres and Redis: AC10.2–AC10.4 (docs/PRD.md),
// bulk replay and its idempotency, and what happens when Redis is down
// (docs/adr/0007-dead-letter-and-replay.md, sequence diagram 4 of docs/ARCHITECTURE.md).
// The api only creates the Delivery and its job; the worker's side of a replay (same webhook-id,
// SEC-OUT-03) is tested in apps/worker/test/delivery.int.test.ts.
import { createApiSubscriberConnection, createLogger, streamChannel } from '@hdl/core';
import type { Delivery as DeliveryRow, Event as EventRow } from '@hdl/database';
import type { BulkReplayResponse, Delivery, ErrorResponse, StreamMessage } from '@hdl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BULK_REPLAY_LIMIT } from '../src/deliveries/replay.service.js';
import { closedPort, createTenant, createTestApp, eventually } from './helpers.js';
import type { TestApiKey, TestApp, TestDestination, TestSource, TestTenant } from './helpers.js';

const DEAD = { status: 'DEAD', deadReason: 'RETRIES_EXHAUSTED', attemptCount: 4 } as const;

describe('replay', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let key: TestApiKey;
  let source: TestSource;
  let destination: TestDestination;
  let event: EventRow;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant(t.prisma, t.env);
    key = await tenant.addApiKey();
    source = await tenant.addSource();
    destination = await tenant.addDestination(source);
    event = await tenant.createEvent(source, { status: 'FANNED_OUT', deliveryCount: 1 });
  });

  afterAll(async () => {
    await tenant.remove();
    await t.close();
  });

  const post = (url: string, app = t) =>
    app.app.inject({ method: 'POST', url, headers: key.headers });

  /** A DEAD delivery with its four failed attempts on record. */
  async function deadDelivery(to: TestDestination = destination): Promise<DeliveryRow> {
    const delivery = await tenant.createDelivery(event, to, {
      ...DEAD,
      lastStatusCode: 503,
      lastErrorCode: 'HTTP_ERROR',
      completedAt: new Date(),
    });
    for (const attemptNumber of [1, 2, 3, 4]) await tenant.addAttempt(delivery, attemptNumber);
    return delivery;
  }

  describe('POST /api/v1/deliveries/:id/replay', () => {
    it('AC10.2 replaying a DEAD delivery returns 202 with a new PENDING delivery: trigger REPLAY, replayOfId set', async () => {
      const original = await deadDelivery();

      const response = await post(`/api/v1/deliveries/${original.id}/replay`);

      expect(response.statusCode).toBe(202);
      const replay = response.json<Delivery>();
      expect(replay).toEqual({
        id: expect.any(String) as string,
        eventId: event.id,
        connectionId: destination.connectionId,
        destinationId: destination.id,
        status: 'PENDING',
        trigger: 'REPLAY',
        replayOfId: original.id,
        // A fresh counter: the replay gets the full number of attempts again.
        attemptCount: 0,
        maxAttempts: t.env.DELIVERY_MAX_ATTEMPTS,
        nextAttemptAt: null,
        lastAttemptAt: null,
        lastStatusCode: null,
        lastErrorCode: null,
        deadReason: null,
        completedAt: null,
        createdAt: expect.any(String) as string,
      });
      expect(replay.id).not.toBe(original.id);
      const stored = await t.prisma.delivery.findUniqueOrThrow({ where: { id: replay.id } });
      expect(stored).toMatchObject({ tenantId: tenant.id, trigger: 'REPLAY', status: 'PENDING' });
    });

    it('AC10.2 replaying a SUCCEEDED delivery works too', async () => {
      const original = await tenant.createDelivery(event, destination, {
        status: 'SUCCEEDED',
        attemptCount: 1,
        completedAt: new Date(),
      });

      const response = await post(`/api/v1/deliveries/${original.id}/replay`);

      expect(response.statusCode).toBe(202);
      expect(response.json<Delivery>()).toMatchObject({
        trigger: 'REPLAY',
        replayOfId: original.id,
      });
    });

    it('AC10.2 the replay gets a delivery job whose id is the new Delivery’s id', async () => {
      const original = await deadDelivery();

      const replay = (await post(`/api/v1/deliveries/${original.id}/replay`)).json<Delivery>();

      const job = await t.deliveryQueue.getJob(replay.id);
      expect(job).toBeDefined();
      expect(job?.name).toBe('delivery.attempt');
      expect(job?.data).toEqual({ deliveryId: replay.id, eventId: event.id, tenantId: tenant.id });
      expect(job?.opts).toMatchObject({
        attempts: t.env.DELIVERY_MAX_ATTEMPTS,
        backoff: { type: 'custom' },
      });
      // The original's job id is not reused: nothing was added under it.
      expect(await t.deliveryQueue.getJob(original.id)).toBeUndefined();
    });

    it('AC10.3 the original delivery and its attempts are unchanged after a replay', async () => {
      const original = await deadDelivery();
      const read = () =>
        t.prisma.delivery.findUniqueOrThrow({
          where: { id: original.id },
          include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
        });
      const before = await read();

      const response = await post(`/api/v1/deliveries/${original.id}/replay`);
      expect(response.statusCode).toBe(202);

      // Every column, updatedAt included: the row was not written at all.
      expect(await read()).toEqual(before);
      expect(before.attempts).toHaveLength(4);
    });

    it('a delivery can be replayed more than once, and a replay can be replayed (a chain)', async () => {
      const original = await deadDelivery();

      const first = (await post(`/api/v1/deliveries/${original.id}/replay`)).json<Delivery>();
      const second = (await post(`/api/v1/deliveries/${original.id}/replay`)).json<Delivery>();
      await t.prisma.delivery.update({
        where: { id: first.id },
        data: { ...DEAD, completedAt: new Date() },
      });
      const ofReplay = (await post(`/api/v1/deliveries/${first.id}/replay`)).json<Delivery>();

      expect(new Set([first.id, second.id, ofReplay.id]).size).toBe(3);
      expect(second.replayOfId).toBe(original.id);
      // replayOfId points at the delivery that was replayed, not at the first of the chain.
      expect(ofReplay.replayOfId).toBe(first.id);
    });

    it.each(['PENDING', 'RETRYING'] as const)(
      'AC10.4 replaying a %s delivery returns 409 CONFLICT and creates nothing',
      async (status) => {
        const inProgress = await tenant.createDelivery(event, destination, {
          status,
          ...(status === 'RETRYING' ? { attemptCount: 1, nextAttemptAt: new Date() } : {}),
        });
        const before = await t.prisma.delivery.count({ where: { tenantId: tenant.id } });

        const response = await post(`/api/v1/deliveries/${inProgress.id}/replay`);

        expect(response.statusCode).toBe(409);
        expect(response.json<ErrorResponse>()).toEqual({
          error: {
            code: 'CONFLICT',
            message: 'Only DEAD or SUCCEEDED deliveries can be replayed.',
            requestId: response.headers['x-request-id'],
          },
        });
        expect(await t.prisma.delivery.count({ where: { tenantId: tenant.id } })).toBe(before);
      },
    );

    it('replaying to a disabled destination returns 409 CONFLICT', async () => {
      const disabled = await tenant.addDestination(source, { enabled: false });
      const original = await deadDelivery(disabled);

      const response = await post(`/api/v1/deliveries/${original.id}/replay`);

      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponse>().error).toMatchObject({
        code: 'CONFLICT',
        message: 'Destination is disabled. Enable it before replaying.',
      });
      expect(await t.prisma.delivery.count({ where: { replayOfId: original.id } })).toBe(0);
    });

    it('a replay still works after the connection was deleted: it goes to the same destination', async () => {
      const lone = await tenant.addDestination(source);
      const original = await deadDelivery(lone);
      await t.prisma.connection.delete({ where: { id: lone.connectionId } });

      const response = await post(`/api/v1/deliveries/${original.id}/replay`);

      expect(response.statusCode).toBe(202);
      expect(response.json<Delivery>()).toMatchObject({
        connectionId: null,
        destinationId: lone.id,
        trigger: 'REPLAY',
      });
    });

    it.each(['019a7b2e-6c1f-7a3b-9d4e-2f1a8c5b7e90', 'not-a-uuid'])(
      'returns 404 NOT_FOUND for %s',
      async (id) => {
        const response = await post(`/api/v1/deliveries/${id}/replay`);

        expect(response.statusCode).toBe(404);
        expect(response.json<ErrorResponse>().error.code).toBe('NOT_FOUND');
      },
    );

    it('publishes delivery.created with trigger REPLAY on the tenant’s stream channel', async () => {
      const original = await deadDelivery();
      const subscriber = createApiSubscriberConnection(
        t.env.REDIS_URL,
        createLogger({ level: 'silent', name: 'test' }),
      );
      const messages: StreamMessage[] = [];
      subscriber.on('message', (_channel: string, raw: string) => {
        messages.push(JSON.parse(raw) as StreamMessage);
      });
      await subscriber.subscribe(streamChannel(tenant.id));
      try {
        const replay = (await post(`/api/v1/deliveries/${original.id}/replay`)).json<Delivery>();

        const message = await eventually(() =>
          messages.find((m) => m.type === 'delivery.created' && m.data.deliveryId === replay.id),
        );
        expect(message).toEqual({
          type: 'delivery.created',
          at: expect.any(String) as string,
          data: {
            deliveryId: replay.id,
            eventId: event.id,
            destinationId: destination.id,
            trigger: 'REPLAY',
            replayOfId: original.id,
          },
        });
      } finally {
        subscriber.disconnect();
      }
    });
  });

  describe('POST /api/v1/destinations/:id/replay-dead', () => {
    /** A destination of its own, so the DEAD deliveries of other tests are not in the way. */
    async function destinationWithDead(count: number) {
      const bulk = await tenant.addDestination(source);
      const dead: DeliveryRow[] = [];
      for (let index = 0; index < count; index += 1) dead.push(await deadDelivery(bulk));
      return { bulk, dead };
    }
    const replaysOf = (destinationId: string) =>
      t.prisma.delivery.findMany({ where: { destinationId, trigger: 'REPLAY' } });

    it('creates one replay for every DEAD delivery of the destination and enqueues each', async () => {
      const { bulk, dead } = await destinationWithDead(3);
      // Not DEAD, so not replayed.
      await tenant.createDelivery(event, bulk, { status: 'SUCCEEDED', completedAt: new Date() });
      await tenant.createDelivery(event, bulk, { status: 'RETRYING', attemptCount: 1 });

      const response = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);

      expect(response.statusCode).toBe(202);
      expect(response.json<BulkReplayResponse>()).toEqual({ replayedCount: 3, hasMore: false });
      const replays = await replaysOf(bulk.id);
      expect(replays.map((replay) => replay.replayOfId).sort()).toEqual(
        dead.map((delivery) => delivery.id).sort(),
      );
      for (const replay of replays) {
        expect(replay).toMatchObject({
          status: 'PENDING',
          attemptCount: 0,
          eventId: event.id,
          connectionId: bulk.connectionId,
          maxAttempts: t.env.DELIVERY_MAX_ATTEMPTS,
        });
        expect(await t.deliveryQueue.getJob(replay.id)).toBeDefined();
      }
    });

    it('is idempotent: a second call skips deliveries that already have a replay', async () => {
      const { bulk } = await destinationWithDead(2);

      const first = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);
      const second = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);

      expect(first.json<BulkReplayResponse>()).toEqual({ replayedCount: 2, hasMore: false });
      expect(second.statusCode).toBe(202);
      expect(second.json<BulkReplayResponse>()).toEqual({ replayedCount: 0, hasMore: false });
      expect(await replaysOf(bulk.id)).toHaveLength(2);
    });

    it('two calls at the same moment do not replay anything twice (a double click on the button)', async () => {
      const { bulk } = await destinationWithDead(5);

      const responses = await Promise.all([
        post(`/api/v1/destinations/${bulk.id}/replay-dead`),
        post(`/api/v1/destinations/${bulk.id}/replay-dead`),
        post(`/api/v1/destinations/${bulk.id}/replay-dead`),
      ]);

      const counts = responses.map((r) => r.json<BulkReplayResponse>().replayedCount);
      // One call did all the work; the others waited for it and found nothing left.
      expect(counts.sort()).toEqual([0, 0, 5]);
      const replays = await replaysOf(bulk.id);
      expect(replays).toHaveLength(5);
      expect(new Set(replays.map((replay) => replay.replayOfId)).size).toBe(5);
    });

    it('a replay that went DEAD is itself picked up by the next bulk replay; its original is not', async () => {
      const { bulk, dead } = await destinationWithDead(1);
      await post(`/api/v1/destinations/${bulk.id}/replay-dead`);
      const [firstReplay] = await replaysOf(bulk.id);
      await t.prisma.delivery.update({
        where: { id: firstReplay?.id ?? '' },
        data: { ...DEAD, completedAt: new Date() },
      });

      const response = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);

      expect(response.json<BulkReplayResponse>()).toEqual({ replayedCount: 1, hasMore: false });
      const replays = await replaysOf(bulk.id);
      expect(replays.map((replay) => replay.replayOfId).sort()).toEqual(
        [dead[0]?.id, firstReplay?.id].sort(),
      );
    });

    it(`replays at most ${BULK_REPLAY_LIMIT} deliveries per call and says hasMore until none are left`, async () => {
      const bulk = await tenant.addDestination(source);
      const total = BULK_REPLAY_LIMIT + 5;
      await t.prisma.delivery.createMany({
        data: Array.from({ length: total }, () => ({
          tenantId: tenant.id,
          eventId: event.id,
          connectionId: bulk.connectionId,
          destinationId: bulk.id,
          maxAttempts: t.env.DELIVERY_MAX_ATTEMPTS,
          ...DEAD,
          completedAt: new Date(),
        })),
      });

      const first = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);
      const second = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);
      const third = await post(`/api/v1/destinations/${bulk.id}/replay-dead`);

      expect(first.json<BulkReplayResponse>()).toEqual({
        replayedCount: BULK_REPLAY_LIMIT,
        hasMore: true,
      });
      expect(second.json<BulkReplayResponse>()).toEqual({ replayedCount: 5, hasMore: false });
      expect(third.json<BulkReplayResponse>()).toEqual({ replayedCount: 0, hasMore: false });
      expect(await t.prisma.delivery.count({ where: { destinationId: bulk.id } })).toBe(total * 2);
      expect(await t.deliveryQueue.getJobCountByTypes('waiting')).toBeGreaterThanOrEqual(total);
    });

    it('returns 409 CONFLICT for a disabled destination and creates nothing', async () => {
      const disabled = await tenant.addDestination(source, { enabled: false });
      await deadDelivery(disabled);

      const response = await post(`/api/v1/destinations/${disabled.id}/replay-dead`);

      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponse>().error).toMatchObject({
        code: 'CONFLICT',
        message: 'Destination is disabled. Enable it before replaying.',
      });
      expect(await replaysOf(disabled.id)).toEqual([]);
    });

    it('returns 202 with replayedCount 0 when the destination has no DEAD deliveries', async () => {
      const quiet = await tenant.addDestination(source);

      const response = await post(`/api/v1/destinations/${quiet.id}/replay-dead`);

      expect(response.statusCode).toBe(202);
      expect(response.json<BulkReplayResponse>()).toEqual({ replayedCount: 0, hasMore: false });
    });

    it.each(['019a7b2e-6c1f-7a3b-9d4e-2f1a8c5b7e90', 'not-a-uuid'])(
      'returns 404 NOT_FOUND for %s',
      async (id) => {
        const response = await post(`/api/v1/destinations/${id}/replay-dead`);

        expect(response.statusCode).toBe(404);
        expect(response.json<ErrorResponse>().error.code).toBe('NOT_FOUND');
      },
    );
  });

  describe('when Redis is down', () => {
    it('a replay still returns 202 quickly; the delivery stays PENDING for the sweeper to enqueue', async () => {
      const original = await deadDelivery();
      const offline = await createTestApp(
        { REDIS_URL: `redis://127.0.0.1:${await closedPort()}/0` },
        { redisReadyTimeoutMs: 100 },
      );
      try {
        const startedAt = Date.now();
        const response = await post(`/api/v1/deliveries/${original.id}/replay`, offline);
        const elapsedMs = Date.now() - startedAt;

        expect(response.statusCode).toBe(202);
        expect(elapsedMs).toBeLessThan(3000);
        const replay = response.json<Delivery>();
        // The row is the source of truth. docs/QUEUES.md#sweeper: PENDING without a job is
        // re-enqueued after SWEEPER_STUCK_AFTER_MS (apps/worker/test/sweeper.int.test.ts, AC11.2).
        const stored = await t.prisma.delivery.findUniqueOrThrow({ where: { id: replay.id } });
        expect(stored).toMatchObject({ status: 'PENDING', trigger: 'REPLAY' });
        expect(await t.deliveryQueue.getJob(replay.id)).toBeUndefined();
      } finally {
        await offline.close();
      }
    });
  });
});
