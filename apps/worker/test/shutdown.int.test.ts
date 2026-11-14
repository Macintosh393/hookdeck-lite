// Integration tests for graceful shutdown (docs/QUEUES.md#graceful-shutdown) and for what the
// worker writes to its log (SEC-LIM-04). The tests call the exported shutdown() that main.ts
// calls on SIGTERM and SIGINT: sending a real signal would stop the test process itself
// (docs/TESTING.md#cross-platform-rules).
import { createSafeHttpClient } from '@hdl/core';
import type { SafeHttpClient } from '@hdl/core';
import { createMockReceiver } from '@hdl/mock-receiver';
import type { MockReceiver } from '@hdl/mock-receiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureLogger,
  createTenant,
  createTestWorker,
  enqueueDeliveryJob,
  enqueueEvent,
  eventually,
  testEnv,
  waitForTerminalDelivery,
} from './helpers.js';
import type { TestTenant, TestWorker } from './helpers.js';
import { startWorker } from '../src/worker-app.js';

describe('worker lifecycle', () => {
  /** Only used to create and remove rows; the tests start their own workers. */
  let support: TestWorker;
  let receiver: MockReceiver;
  let tenant: TestTenant;

  beforeAll(async () => {
    support = await createTestWorker();
    receiver = await createMockReceiver({ log: false }).listen(0);
    tenant = await createTenant(support.prisma, support.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await support.close();
    await receiver.close();
  });

  async function pendingDelivery(bucket: string) {
    const destination = await tenant.addDestination({ url: receiver.urlFor(bucket) });
    const event = await tenant.createEvent();
    await support.prisma.event.update({ where: { id: event.id }, data: { status: 'FANNED_OUT' } });
    return tenant.createDelivery(event, destination);
  }

  /** Deletes the Redis keys of a worker that was shut down the real way (createTestWorker's close does it itself). */
  async function removeQueues(prefix: string): Promise<void> {
    const cleaner = await createTestWorker({ BULLMQ_PREFIX: prefix });
    await cleaner.close();
  }

  describe('graceful shutdown', () => {
    it('finishes the active delivery, records its attempt, and then closes', async () => {
      const logs = captureLogger();
      const env = testEnv();
      const app = await startWorker(env, { logger: logs.logger, runSweeper: false });
      // The receiver answers after 400 ms: long enough for shutdown to start in the middle.
      receiver.setScenario('slow', { default: { status: 200, delayMs: 400 } });
      const delivery = await pendingDelivery('slow');
      await enqueueDeliveryJob(app.ctx, delivery);
      await eventually(() => receiver.requests('slow').length === 1);
      const before = await support.prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(before.status).toBe('PENDING'); // the request is in flight, nothing is recorded yet

      const first = app.shutdown();
      const second = app.shutdown(); // a second Ctrl+C during the wait
      await first;

      expect(second).toBe(first);
      const after = await support.prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: { attempts: true },
      });
      expect(after).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
      expect(after.attempts).toHaveLength(1);
      expect(receiver.requests('slow')).toHaveLength(1);
      const messages = logs.lines().map((line) => line.msg);
      expect(messages).toContain('Worker shutting down: waiting for active jobs');
      expect(messages.at(-1)).toBe('Worker stopped');
      expect(messages).not.toContain(
        'Active jobs did not finish in time; exiting anyway. They will be re-run as stalled jobs',
      );
      await removeQueues(env.BULLMQ_PREFIX);
    });

    it('gives up after the timeout; the job is re-run by another worker as a stalled job (a duplicate delivery)', async () => {
      const logs = captureLogger();
      const env = testEnv();
      // Locks of 500 ms, so the job counts as stalled soon after the first worker is gone.
      const stalled = { lockDuration: 500, stalledInterval: 200, maxStalledCount: 1 };
      // An attempt that never comes back: the request is really sent, but the processor waits
      // for it forever. In production the process exits at this point; in a test it lives on,
      // and a processor that woke up later would write to connections that are closed.
      const real = createSafeHttpClient({
        allowlist: env.SSRF_ALLOWLIST,
        timeoutMs: 1000,
        maxResponseBytes: env.DELIVERY_MAX_RESPONSE_BYTES,
      });
      const neverReturns: SafeHttpClient = {
        post: (request) => {
          void real.post(request);
          return new Promise(() => {});
        },
      };
      const app = await startWorker(env, {
        logger: logs.logger,
        httpClient: neverReturns,
        runSweeper: false,
        shutdownTimeoutMs: 200,
        stalled,
      });
      // The first request gets no answer for a minute; every later one is answered at once.
      receiver.setScenario('stuck', {
        responses: [{ status: 200, delayMs: 60_000 }],
        default: { status: 200 },
      });
      const delivery = await pendingDelivery('stuck');
      await enqueueDeliveryJob(app.ctx, delivery);
      await eventually(() => receiver.requests('stuck').length === 1);

      const started = Date.now();
      await app.shutdown();

      // It waited for the 200 ms, not for the request.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(logs.lines().map((line) => line.msg)).toContain(
        'Active jobs did not finish in time; exiting anyway. They will be re-run as stalled jobs',
      );
      const abandoned = await support.prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(abandoned).toMatchObject({ status: 'PENDING', attemptCount: 0 });

      // The next worker process (a deploy, or a restart after the crash).
      const next = await createTestWorker({ BULLMQ_PREFIX: env.BULLMQ_PREFIX }, { stalled });
      try {
        const done = await waitForTerminalDelivery(support.prisma, delivery.id);

        expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
        // At-least-once: the destination got the event twice, with the same webhook-id.
        const requests = receiver.requests('stuck');
        expect(requests).toHaveLength(2);
        expect(requests[1]?.headers['webhook-id']).toBe(requests[0]?.headers['webhook-id']);
        expect(requests[1]?.headers['x-hdl-attempt']).toBe('1');
      } finally {
        await next.close();
      }
    });
  });

  describe('log hygiene', () => {
    it('SEC-LIM-04 the worker’s logs of a fan-out → retry → deliver cycle contain no secret, signature or payload', async () => {
      const logs = captureLogger('trace');
      const worker = await createTestWorker({}, { logger: logs.logger });
      try {
        const destination = await tenant.addDestination({ url: receiver.urlFor('hygiene') });
        receiver.setScenario('hygiene', { responses: [{ status: 500 }], default: { status: 200 } });
        const body = '{"type":"order.created","card":"4242-secret-payload-marker"}';
        const event = await tenant.createEvent({ body });

        await enqueueEvent(worker.ctx, event);
        const delivery = await eventually(async () => {
          const row = await worker.prisma.delivery.findFirst({
            where: { eventId: event.id, destinationId: destination.id },
          });
          return row?.status === 'SUCCEEDED' ? row : null;
        });
        expect(delivery.attemptCount).toBe(2);

        // The cycle was logged at all: otherwise the checks below would pass on an empty log.
        // Wait for the lines: the processor logs after it has committed and published, so the
        // row can say SUCCEEDED a moment before the second "attempt recorded" line exists.
        await eventually(
          () =>
            logs
              .lines()
              .filter(
                (line) =>
                  line.msg === 'Delivery attempt recorded' && line.deliveryId === delivery.id,
              ).length === 2,
        );
        const raw = logs.raw();
        expect(logs.lines().map((line) => line.msg)).toContain('Event fanned out');
        // The signing secret, with and without its prefix.
        expect(raw).not.toContain(destination.signingSecret);
        expect(raw).not.toContain(destination.signingSecret.replace('whsec_', ''));
        expect(raw).not.toContain(worker.env.SECRETS_MASTER_KEY);
        // The signatures that were sent.
        const requests = receiver.requests('hygiene');
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          const signature = request.headers['webhook-signature'] ?? '';
          expect(signature).toMatch(/^v1,/);
          expect(raw).not.toContain(signature);
          expect(raw).not.toContain(signature.replace('v1,', ''));
        }
        // The payload.
        expect(raw).not.toContain('4242-secret-payload-marker');
        // The stored attempt keeps the headers for the dashboard, with the signature replaced.
        const attempts = await worker.prisma.deliveryAttempt.findMany({
          where: { deliveryId: delivery.id },
        });
        for (const attempt of attempts) {
          expect(attempt.requestHeaders).toMatchObject({ 'webhook-signature': '[redacted]' });
        }
      } finally {
        await worker.close();
      }
    });
  });
});
