// Integration tests for the delivery processor: real Postgres, real Redis and BullMQ, and the mock
// receiver on a real socket. Covers AC7.1–AC7.6, AC8.1–AC8.3 and SEC-OUT-02 to SEC-OUT-04
// (docs/PRD.md, docs/SECURITY.md) and sequence diagrams 3 and 4 of docs/ARCHITECTURE.md.
//
// Retries use the integration backoff profile of docs/QUEUES.md (20 ms base, 200 ms cap,
// 4 attempts), and the jitter's random source is fixed at 0.5, so every delay is exact.
import { createApiSubscriberConnection, createStreamSubscriber } from '@hdl/core';
import type { DeliveryJobData, Job, SafeHttpClient } from '@hdl/core';
import { createMockReceiver } from '@hdl/mock-receiver';
import type { MockReceiver } from '@hdl/mock-receiver';
import type { StreamMessage } from '@hdl/shared';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDelivery } from '../src/delivery/delivery.processor.js';
import {
  captureLogger,
  createTenant,
  createTestWorker,
  deliveriesOf,
  enqueueDeliveryJob,
  enqueueEvent,
  eventually,
  SAMPLE_BODY,
  waitForTerminalDelivery,
} from './helpers.js';
import type { TestTenant, TestWorker } from './helpers.js';

describe('delivery processor', () => {
  const logs = captureLogger();
  let worker: TestWorker;
  let receiver: MockReceiver;
  let tenant: TestTenant;

  beforeAll(async () => {
    worker = await createTestWorker({}, { logger: logs.logger, random: () => 0.5 });
    receiver = await createMockReceiver({ log: false }).listen(0);
    tenant = await createTenant(worker.prisma, worker.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await worker.close();
    await receiver.close();
  });

  /** A destination at its own bucket, an event, and its delivery, fanned out by the worker. */
  async function deliver(bucket: string, urlSuffix = '', body = SAMPLE_BODY) {
    const destination = await tenant.addDestination({ url: receiver.urlFor(bucket) + urlSuffix });
    const event = await tenant.createEvent({ body });
    // Only this destination's delivery matters; the tenant's other connections also fan out.
    const delivery = await tenant.createDelivery(event, destination);
    await worker.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
    await enqueueDeliveryJob(worker.ctx, delivery);
    return { destination, event, delivery };
  }

  /** The `retryInMs` the worker logged for each failed attempt of a delivery, in order. */
  const loggedDelays = (deliveryId: string): unknown[] =>
    logs
      .lines()
      .filter((line) => line.msg === 'Delivery attempt recorded' && line.deliveryId === deliveryId)
      .filter((line) => line.status === 'RETRYING')
      .map((line) => line.retryInMs);

  const jobFor = (data: DeliveryJobData) => ({ data }) as Job<DeliveryJobData>;

  describe('success', () => {
    it('AC7.1 a 2xx response marks the delivery SUCCEEDED after one attempt', async () => {
      const { delivery } = await deliver('ok');

      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(done).toMatchObject({
        status: 'SUCCEEDED',
        attemptCount: 1,
        lastStatusCode: 200,
        lastErrorCode: null,
        deadReason: null,
        nextAttemptAt: null,
      });
      expect(done.completedAt).toBeInstanceOf(Date);
      expect(done.attempts).toHaveLength(1);
      expect(receiver.requests('ok')).toHaveLength(1);
    });

    it('AC7.6 the attempt is recorded with status code, duration, pinned IP, headers and response body', async () => {
      const { delivery, event } = await deliver('recorded');

      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);
      const [attempt] = done.attempts;

      expect(attempt).toMatchObject({
        tenantId: tenant.id,
        attemptNumber: 1,
        outcome: 'SUCCESS',
        statusCode: 200,
        errorCode: null,
        errorMessage: null,
        retryAfterMs: null,
        resolvedIp: '127.0.0.1',
        responseBody: '{"ok":true}',
        responseBodyTruncated: false,
      });
      expect(attempt?.durationMs).toBeGreaterThanOrEqual(0);
      expect(attempt?.startedAt).toBeInstanceOf(Date);
      expect(attempt?.responseHeaders).toMatchObject({ 'content-type': 'application/json' });
      // The stored request headers show what was sent, except the signature itself.
      expect(attempt?.requestHeaders).toMatchObject({
        'webhook-id': event.id,
        'webhook-signature': '[redacted]',
        'content-type': 'application/json',
        'user-agent': 'hookdeck-lite/1.0',
        'x-hdl-delivery-id': delivery.id,
        'x-hdl-attempt': '1',
      });
    });

    it('AC8.1 every outbound request carries webhook-id, webhook-timestamp and webhook-signature', async () => {
      const { delivery, event } = await deliver('headers');
      await waitForTerminalDelivery(worker.prisma, delivery.id);

      const [request] = receiver.requests('headers');
      expect(request?.headers['webhook-id']).toBe(event.id);
      expect(request?.headers['webhook-timestamp']).toMatch(/^\d{10}$/);
      expect(request?.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
      expect(request?.headers).toMatchObject({
        'content-type': 'application/json',
        'user-agent': 'hookdeck-lite/1.0',
        'x-hdl-delivery-id': delivery.id,
        'x-hdl-attempt': '1',
      });
      const sentAt = Number(request?.headers['webhook-timestamp']);
      expect(Math.abs(sentAt - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(5);
    });

    it('AC8.2 the official standardwebhooks library verifies the signature with the destination’s secret', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('verified') });
      receiver.setScenario('verified', { verifySecret: destination.signingSecret });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);

      await enqueueDeliveryJob(worker.ctx, delivery);
      await waitForTerminalDelivery(worker.prisma, delivery.id);

      const [request] = receiver.requests('verified');
      expect(request?.signatureValid).toBe(true);
      // And checked here directly, with the library a receiver would use.
      expect(() =>
        new Webhook(destination.signingSecret).verify(request!.body, request!.headers),
      ).not.toThrow();
      // A different secret must not verify: the check above is not vacuous.
      expect(() =>
        new Webhook('whsec_d3JvbmctanVzdC13cm9uZy13cm9uZy13cm9uZy0zMg==').verify(
          request!.body,
          request!.headers,
        ),
      ).toThrow();
    });

    it('SEC-OUT-04 the body received by the mock receiver is byte-identical to the body ingested', async () => {
      // Spacing, key order, a BOM-like character, unicode and escapes that JSON.parse +
      // JSON.stringify would not preserve.
      const body = '{ "b" : 1,\n\t"a":"ünï \\u2713 ✓",  "n": 1.50, "e": 1e3 }\n';
      const { delivery } = await deliver('bytes', '', body);

      await waitForTerminalDelivery(worker.prisma, delivery.id);

      const [request] = receiver.requests('bytes');
      expect(request?.body).toBe(body);
      expect(Buffer.from(request!.body, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true);
      expect(request?.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    });

    it('does nothing for a delivery that is already SUCCEEDED or DEAD, or that no longer exists', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('terminal') });
      const event = await tenant.createEvent();
      const succeeded = await tenant.createDelivery(event, destination, { status: 'SUCCEEDED' });
      const dead = await tenant.createDelivery(event, destination, { status: 'DEAD' });
      const ids = { eventId: event.id, tenantId: tenant.id };

      await processDelivery(worker.ctx, jobFor({ deliveryId: succeeded.id, ...ids }));
      await processDelivery(worker.ctx, jobFor({ deliveryId: dead.id, ...ids }));
      await processDelivery(
        worker.ctx,
        jobFor({ deliveryId: '019a7b00-0000-7000-8000-00000000dead', ...ids }),
      );

      expect(receiver.requests('terminal')).toEqual([]);
      expect(await worker.prisma.deliveryAttempt.count({ where: { deliveryId: dead.id } })).toBe(0);
    });
  });

  describe('retries', () => {
    it('AC7.2 retry → success: two failures then a 200 give three attempts and SUCCEEDED', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('flaky') });
      receiver.setScenario('flaky', {
        responses: [{ status: 500 }, { status: 503 }],
        default: { status: 200 },
      });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);

      await enqueueDeliveryJob(worker.ctx, delivery);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 3, lastStatusCode: 200 });
      expect(done.attempts.map((a) => [a.attemptNumber, a.outcome, a.statusCode])).toEqual([
        [1, 'RETRYABLE_FAILURE', 500],
        [2, 'RETRYABLE_FAILURE', 503],
        [3, 'SUCCESS', 200],
      ]);
      expect(done.attempts[0]).toMatchObject({
        errorCode: 'HTTP_ERROR',
        errorMessage: 'Destination responded with 500.',
      });
      // x-hdl-attempt counts up; the delivery id stays.
      expect(receiver.requests('flaky').map((r) => r.headers['x-hdl-attempt'])).toEqual([
        '1',
        '2',
        '3',
      ]);
    });

    it.each([408, 429, 500, 502, 503, 504])(
      'AC7.2 a %i marks the delivery RETRYING and schedules another attempt',
      async (status) => {
        const bucket = `retry-${status}`;
        const destination = await tenant.addDestination({ url: receiver.urlFor(bucket) });
        receiver.setScenario(bucket, { responses: [{ status }], default: { status: 200 } });
        const event = await tenant.createEvent();
        const delivery = await tenant.createDelivery(event, destination);

        await enqueueDeliveryJob(worker.ctx, delivery);
        const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

        expect(done.status).toBe('SUCCEEDED');
        expect(done.attempts.map((a) => a.outcome)).toEqual(['RETRYABLE_FAILURE', 'SUCCESS']);
        expect(done.attempts[0]?.statusCode).toBe(status);
      },
    );

    it('AC7.2 a network error (connection refused) is retried, then the delivery is DEAD', async () => {
      // A port nothing listens on: start a receiver, note its port, close it.
      const closed = await createMockReceiver({ log: false }).listen(0);
      const url = closed.urlFor('nobody-home');
      await closed.close();
      const destination = await tenant.addDestination({ url });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);

      await enqueueDeliveryJob(worker.ctx, delivery);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'RETRIES_EXHAUSTED',
        attemptCount: 4,
        lastStatusCode: null,
        lastErrorCode: 'NETWORK_ERROR',
      });
      for (const attempt of done.attempts) {
        expect(attempt).toMatchObject({
          outcome: 'RETRYABLE_FAILURE',
          statusCode: null,
          errorCode: 'NETWORK_ERROR',
          resolvedIp: '127.0.0.1',
          responseBody: null,
        });
        expect(attempt.errorMessage).toBeTruthy();
      }
    });

    it('AC7.4 retries exhausted → DEAD: after DELIVERY_MAX_ATTEMPTS failed attempts, deadReason is RETRIES_EXHAUSTED', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('down') });
      receiver.setScenario('down', { default: { status: 503 } });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);

      await enqueueDeliveryJob(worker.ctx, delivery);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(worker.env.DELIVERY_MAX_ATTEMPTS).toBe(4);
      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'RETRIES_EXHAUSTED',
        attemptCount: 4,
        lastStatusCode: 503,
        lastErrorCode: 'HTTP_ERROR',
        nextAttemptAt: null,
      });
      expect(done.completedAt).toBeInstanceOf(Date);
      expect(done.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4]);
      expect(done.attempts.every((a) => a.outcome === 'RETRYABLE_FAILURE')).toBe(true);
      expect(receiver.requests('down')).toHaveLength(4);

      // The job is in BullMQ's failed set (there is no dead-letter queue; the row is the dead letter).
      const job = await eventually(() => worker.ctx.deliveryQueue.getJob(delivery.id));
      expect(await eventually(async () => (await job.getState()) === 'failed')).toBe(true);
    });

    it('AC7.5 the delays follow the formula: half of 20, 40 and 80 ms with the random source at 0.5', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('formula') });
      receiver.setScenario('formula', { default: { status: 500 } });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);

      await enqueueDeliveryJob(worker.ctx, delivery);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      // floor(0.5 × min(200, 20 × 2^(n−1))) for n = 1, 2, 3. Attempt 4 is the last: no delay.
      expect(loggedDelays(delivery.id)).toEqual([10, 20, 40]);
      // Each attempt started no earlier than the delay asked for after the previous one.
      for (let i = 1; i < done.attempts.length; i++) {
        const previous = done.attempts[i - 1]!;
        const gapMs = done.attempts[i]!.startedAt.getTime() - previous.startedAt.getTime();
        expect(gapMs).toBeGreaterThanOrEqual([10, 20, 40][i - 1]!);
      }
    });

    it('AC7.5 Retry-After on a 503 is honored up to the cap; on a 500 it is ignored', async () => {
      const honoring = await tenant.addDestination({ url: receiver.urlFor('retry-after-503') });
      const ignoring = await tenant.addDestination({ url: receiver.urlFor('retry-after-500') });
      // 1 second asked; BACKOFF_CAP_MS is 200 in the integration profile.
      receiver.setScenario('retry-after-503', {
        responses: [{ status: 503, retryAfter: 1 }],
        default: { status: 200 },
      });
      receiver.setScenario('retry-after-500', {
        responses: [{ status: 500, retryAfter: 1 }],
        default: { status: 200 },
      });
      const event = await tenant.createEvent();
      const honored = await tenant.createDelivery(event, honoring);
      const ignored = await tenant.createDelivery(event, ignoring);

      await enqueueDeliveryJob(worker.ctx, honored);
      await enqueueDeliveryJob(worker.ctx, ignored);
      const honoredDone = await waitForTerminalDelivery(worker.prisma, honored.id);
      const ignoredDone = await waitForTerminalDelivery(worker.prisma, ignored.id);

      expect(loggedDelays(honored.id)).toEqual([200]); // min(1000, cap 200), above the 10 ms jitter
      expect(loggedDelays(ignored.id)).toEqual([10]); // the jittered delay only
      // The parsed header is stored either way.
      expect(honoredDone.attempts[0]?.retryAfterMs).toBe(1000);
      expect(ignoredDone.attempts[0]?.retryAfterMs).toBe(1000);
      expect(honoredDone.attempts[0]?.responseHeaders).toMatchObject({ 'retry-after': '1' });

      const gapMs =
        honoredDone.attempts[1]!.startedAt.getTime() - honoredDone.attempts[0]!.startedAt.getTime();
      expect(gapMs).toBeGreaterThanOrEqual(200);
    });

    it('AC7.5 Retry-After on a 429 is honored too', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('retry-after-429') });
      receiver.setScenario('retry-after-429', {
        responses: [{ status: 429, retryAfter: 1 }],
        default: { status: 200 },
      });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);

      await enqueueDeliveryJob(worker.ctx, delivery);
      await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(loggedDelays(delivery.id)).toEqual([200]);
    });

    it('Postgres is the attempt counter of record: a delivery at attemptCount 3 of 4 gets attempt number 4 and then DEAD', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('counter') });
      receiver.setScenario('counter', { default: { status: 503 } });
      const event = await tenant.createEvent();
      // As after a Redis wipe: the row says three attempts were made, and the job is brand new
      // (BullMQ's own attemptsMade is 0 and it believes four attempts are left).
      const delivery = await tenant.createDelivery(event, destination, {
        status: 'RETRYING',
        attemptCount: 3,
        nextAttemptAt: new Date(),
      });

      await enqueueDeliveryJob(worker.ctx, delivery);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'RETRIES_EXHAUSTED',
        attemptCount: 4,
      });
      expect(done.attempts.map((a) => a.attemptNumber)).toEqual([4]);
      expect(receiver.requests('counter')).toHaveLength(1);
      expect(receiver.requests('counter')[0]?.headers['x-hdl-attempt']).toBe('4');
    });
  });

  describe('permanent failures', () => {
    it.each([400, 401, 403, 404, 410, 422])(
      'AC7.3 permanent failure → DEAD: a %i marks the delivery DEAD immediately, with no further attempts',
      async (status) => {
        const bucket = `permanent-${status}`;
        const destination = await tenant.addDestination({ url: receiver.urlFor(bucket) });
        receiver.setScenario(bucket, { default: { status, body: 'no thanks' } });
        const event = await tenant.createEvent();
        const delivery = await tenant.createDelivery(event, destination);

        await enqueueDeliveryJob(worker.ctx, delivery);
        const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

        expect(done).toMatchObject({
          status: 'DEAD',
          deadReason: 'PERMANENT_FAILURE',
          attemptCount: 1,
          lastStatusCode: status,
          lastErrorCode: 'HTTP_ERROR',
        });
        expect(done.attempts).toHaveLength(1);
        expect(done.attempts[0]).toMatchObject({
          outcome: 'PERMANENT_FAILURE',
          statusCode: status,
          responseBody: 'no thanks',
        });
        // Give a wrong retry the time to happen before asserting that none did.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(receiver.requests(bucket)).toHaveLength(1);
      },
    );

    it('AC7.3 a 3xx marks the delivery DEAD immediately (REDIRECT_NOT_FOLLOWED)', async () => {
      const { delivery } = await deliver('moved', '?status=301');

      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'PERMANENT_FAILURE',
        attemptCount: 1,
        lastStatusCode: 301,
        lastErrorCode: 'REDIRECT_NOT_FOLLOWED',
      });
      expect(done.attempts[0]?.errorMessage).toBe(
        'Destination responded with 301. Redirects are not followed.',
      );
    });

    it('a delivery to a disabled destination is DEAD without an attempt (DESTINATION_DISABLED)', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('disabled') });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);
      // Disabled after fan-out created the delivery, before the worker got to it.
      await worker.prisma.destination.update({
        where: { id: destination.id },
        data: { enabled: false },
      });

      await enqueueDeliveryJob(worker.ctx, delivery);
      const done = await waitForTerminalDelivery(worker.prisma, delivery.id);

      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'PERMANENT_FAILURE',
        lastErrorCode: 'DESTINATION_DISABLED',
        attemptCount: 0,
      });
      expect(done.attempts).toEqual([]);
      expect(receiver.requests('disabled')).toEqual([]);
    });
  });

  describe('compare-and-set on the delivery status', () => {
    /** A context whose HTTP client runs `meanwhile` after the request was sent, before it returns. */
    const contextWhere = (meanwhile: () => Promise<unknown>) => {
      const realClient = worker.ctx.httpClient;
      const httpClient: SafeHttpClient = {
        async post(request) {
          const result = await realClient.post(request);
          await meanwhile();
          return result;
        },
      };
      return { ...worker.ctx, httpClient };
    };

    it('a second record of the same attempt hits the unique index; the run continues from the stored state', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('double') });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);
      const job = jobFor({ deliveryId: delivery.id, eventId: event.id, tenantId: tenant.id });

      // While this run's request is in flight, another run of the same job (a stalled job that
      // was picked up again) records attempt 1 and finishes the delivery.
      const ctx = contextWhere(() => processDelivery(worker.ctx, job));

      await expect(processDelivery(ctx, job)).resolves.toBeUndefined();

      const [after] = (await deliveriesOf(worker.prisma, event.id)).filter(
        (d) => d.id === delivery.id,
      );
      expect(after).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
      expect(after?.attempts).toHaveLength(1); // one row, not two
      // The destination did receive the request twice: at-least-once, with the same webhook-id.
      const requests = receiver.requests('double');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.headers['webhook-id']).toBe(requests[1]?.headers['webhook-id']);
    });

    it('a delivery that became DEAD while the request was in flight is not overwritten', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('raced') });
      const event = await tenant.createEvent();
      const delivery = await tenant.createDelivery(event, destination);
      const job = jobFor({ deliveryId: delivery.id, eventId: event.id, tenantId: tenant.id });

      // Meanwhile something else (the failed listener, the sweeper) marks the delivery DEAD.
      const ctx = contextWhere(() =>
        worker.prisma.delivery.update({
          where: { id: delivery.id },
          data: { status: 'DEAD', deadReason: 'STALLED', completedAt: new Date() },
        }),
      );

      await expect(processDelivery(ctx, job)).rejects.toThrow(/DEAD \(STALLED\)/);

      const after = await worker.prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: { attempts: true },
      });
      // Still DEAD/STALLED, although this run got a 200: a terminal row never changes.
      expect(after).toMatchObject({ status: 'DEAD', deadReason: 'STALLED', attemptCount: 0 });
      expect(after.attempts).toEqual([]); // the attempt insert was rolled back with the update
    });
  });

  describe('outbound signing across attempts and replays', () => {
    it('SEC-OUT-03 a replay carries the same webhook-id as the original', async () => {
      const destination = await tenant.addDestination({ url: receiver.urlFor('replayed') });
      receiver.setScenario('replayed', { verifySecret: destination.signingSecret });
      const event = await tenant.createEvent();
      const original = await tenant.createDelivery(event, destination);
      await enqueueDeliveryJob(worker.ctx, original);
      await waitForTerminalDelivery(worker.prisma, original.id);

      // What POST /api/v1/deliveries/{id}/replay does: a new row and a new job.
      const replay = await tenant.createDelivery(event, destination, {
        trigger: 'REPLAY',
        replayOfId: original.id,
      });
      await enqueueDeliveryJob(worker.ctx, replay);
      const replayed = await waitForTerminalDelivery(worker.prisma, replay.id);

      const [first, second] = receiver.requests('replayed');
      expect(first?.headers['webhook-id']).toBe(event.id);
      expect(second?.headers['webhook-id']).toBe(event.id);
      // The delivery id is what tells them apart.
      expect(first?.headers['x-hdl-delivery-id']).toBe(original.id);
      expect(second?.headers['x-hdl-delivery-id']).toBe(replay.id);
      expect(second?.headers['x-hdl-attempt']).toBe('1'); // a fresh attempt counter
      expect(second?.signatureValid).toBe(true);
      expect(replayed).toMatchObject({ status: 'SUCCEEDED', trigger: 'REPLAY', attemptCount: 1 });

      // AC10.3: the original and its attempts are untouched.
      const originalAfter = await worker.prisma.delivery.findUniqueOrThrow({
        where: { id: original.id },
        include: { attempts: true },
      });
      expect(originalAfter).toMatchObject({
        status: 'SUCCEEDED',
        attemptCount: 1,
        trigger: 'EVENT',
      });
      expect(originalAfter.attempts).toHaveLength(1);
    });

    it('AC8.3 webhook-id is the same for every destination of an event', async () => {
      const first = await tenant.addDestination({ url: receiver.urlFor('same-id-a') });
      const second = await tenant.addDestination({ url: receiver.urlFor('same-id-b') });
      const event = await tenant.createEvent();
      const a = await tenant.createDelivery(event, first);
      const b = await tenant.createDelivery(event, second);

      await enqueueDeliveryJob(worker.ctx, a);
      await enqueueDeliveryJob(worker.ctx, b);
      await waitForTerminalDelivery(worker.prisma, a.id);
      await waitForTerminalDelivery(worker.prisma, b.id);

      expect(receiver.requests('same-id-a')[0]?.headers['webhook-id']).toBe(event.id);
      expect(receiver.requests('same-id-b')[0]?.headers['webhook-id']).toBe(event.id);
    });
  });

  describe('live stream', () => {
    it('publishes delivery.attempted for each attempt, with the status and the next attempt time', async () => {
      const subscriberConnection = createApiSubscriberConnection(worker.env.REDIS_URL, logs.logger);
      const subscriber = createStreamSubscriber(subscriberConnection, logs.logger);
      const seen: StreamMessage[] = [];
      await subscriber.subscribe(tenant.id, (message) => seen.push(message));
      try {
        const destination = await tenant.addDestination({ url: receiver.urlFor('streamed') });
        receiver.setScenario('streamed', {
          responses: [{ status: 503 }],
          default: { status: 200 },
        });
        const event = await tenant.createEvent();
        const delivery = await tenant.createDelivery(event, destination);

        await enqueueDeliveryJob(worker.ctx, delivery);
        await waitForTerminalDelivery(worker.prisma, delivery.id);
        const attempted = await eventually(() => {
          const messages = seen.filter(
            (m) => m.type === 'delivery.attempted' && m.data.deliveryId === delivery.id,
          );
          return messages.length === 2 ? messages : null;
        });

        expect(attempted[0]).toMatchObject({
          type: 'delivery.attempted',
          data: {
            deliveryId: delivery.id,
            eventId: event.id,
            destinationId: destination.id,
            attemptNumber: 1,
            outcome: 'RETRYABLE_FAILURE',
            statusCode: 503,
            errorCode: 'HTTP_ERROR',
            status: 'RETRYING',
          },
        });
        expect(
          attempted[0]?.type === 'delivery.attempted' && attempted[0].data.nextAttemptAt,
        ).toBeTruthy();
        expect(attempted[1]).toMatchObject({
          data: {
            attemptNumber: 2,
            outcome: 'SUCCESS',
            statusCode: 200,
            errorCode: null,
            status: 'SUCCEEDED',
            nextAttemptAt: null,
          },
        });
      } finally {
        await subscriber.close();
        subscriberConnection.disconnect();
      }
    });
  });

  describe('end to end through fan-out', () => {
    it('an enqueued event is fanned out and delivered to every matching destination', async () => {
      const own = await createTenant(worker.prisma, worker.env);
      try {
        await own.addDestination({ url: receiver.urlFor('e2e-a') });
        await own.addDestination({ url: receiver.urlFor('e2e-b') });
        await own.addDestination({
          url: receiver.urlFor('e2e-filtered'),
          filter: { body: { type: 'order.refunded' } },
        });
        const event = await own.createEvent();

        await enqueueEvent(worker.ctx, event);
        const deliveries = await eventually(async () => {
          const all = await deliveriesOf(worker.prisma, event.id);
          return all.length === 2 && all.every((d) => d.status === 'SUCCEEDED') ? all : null;
        });

        expect(deliveries).toHaveLength(2);
        expect(receiver.requests('e2e-a')).toHaveLength(1);
        expect(receiver.requests('e2e-b')).toHaveLength(1);
        expect(receiver.requests('e2e-filtered')).toEqual([]);
      } finally {
        await own.remove();
      }
    });
  });
});

describe('delivery processor with a backoff cap above one second', () => {
  // A second worker whose cap lets a retry wait for more than a second, because the
  // webhook-timestamp header has a resolution of one second.
  let worker: TestWorker;
  let receiver: MockReceiver;
  let tenant: TestTenant;

  beforeAll(async () => {
    worker = await createTestWorker({ BACKOFF_CAP_MS: '1100' }, { random: () => 0 });
    receiver = await createMockReceiver({ log: false }).listen(0);
    tenant = await createTenant(worker.prisma, worker.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await worker.close();
    await receiver.close();
  });

  it('SEC-OUT-02 two attempts of one delivery carry the same webhook-id and different webhook-timestamp', async () => {
    const destination = await tenant.addDestination({ url: receiver.urlFor('two-attempts') });
    // Retry-After: 2 s, capped at 1.1 s: the second attempt is sent in a later second.
    receiver.setScenario('two-attempts', {
      responses: [{ status: 503, retryAfter: 2 }],
      default: { status: 200 },
      verifySecret: destination.signingSecret,
    });
    const event = await tenant.createEvent();
    const delivery = await tenant.createDelivery(event, destination);

    await enqueueDeliveryJob(worker.ctx, delivery);

    // AC7.2: between the attempts the delivery is RETRYING with the next attempt scheduled.
    const retrying = await eventually(async () => {
      const row = await worker.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      return row.status === 'RETRYING' ? row : null;
    });
    expect(retrying.attemptCount).toBe(1);
    expect(
      retrying.nextAttemptAt!.getTime() - retrying.lastAttemptAt!.getTime(),
    ).toBeGreaterThanOrEqual(1100);
    expect(retrying.completedAt).toBeNull();

    const done = await waitForTerminalDelivery(worker.prisma, delivery.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 });

    const [first, second] = receiver.requests('two-attempts');
    expect(first?.headers['webhook-id']).toBe(event.id);
    expect(second?.headers['webhook-id']).toBe(event.id);
    const firstSentAt = Number(first?.headers['webhook-timestamp']);
    const secondSentAt = Number(second?.headers['webhook-timestamp']);
    // AC8.3: the timestamp is the send time of each attempt, not the event's time.
    expect(secondSentAt).toBeGreaterThan(firstSentAt);
    expect(first?.headers['webhook-signature']).not.toBe(second?.headers['webhook-signature']);
    // Both verify: each signature covers its own timestamp.
    expect([first?.signatureValid, second?.signatureValid]).toEqual([true, true]);
    // The stored headers of the two attempts show the two timestamps too.
    expect(
      done.attempts.map((a) => (a.requestHeaders as Record<string, string>)['webhook-timestamp']),
    ).toEqual([String(firstSentAt), String(secondSentAt)]);
  });
});
