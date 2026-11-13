// Helpers shared by the worker's integration tests: starting the worker inside the test process,
// creating a tenant with a source, destinations and events directly in the database, and waiting
// for asynchronous outcomes.
// Isolation rules (docs/TESTING.md#isolation-between-tests): each file has its own tenant and
// its own BULLMQ_PREFIX, and removes both when it is done.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createLogger,
  encryptSecret,
  enqueueDelivery,
  enqueueFanout,
  generateWhsecSecret,
  parseEnv,
  parseMasterKey,
} from '@hdl/core';
import type { Env, Logger } from '@hdl/core';
import type { Delivery, DeliveryAttempt, Event, Prisma, PrismaClient } from '@hdl/database';
import type { WorkerContext } from '../src/context.js';
import { startWorker } from '../src/worker-app.js';
import type { StartWorkerOptions, WorkerApp } from '../src/worker-app.js';

/** The test environment (.env.test) with a queue prefix no other test file uses. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    ...process.env,
    BULLMQ_PREFIX: `hdl-test-${randomUUID().slice(0, 8)}`,
    ...overrides,
  });
}

export interface TestWorker {
  app: WorkerApp;
  ctx: WorkerContext;
  env: Env;
  prisma: PrismaClient;
  /** Stops the Workers, removes the queues' keys from Redis, and closes every connection. */
  close(): Promise<void>;
}

/**
 * Starts a whole worker in this process. The sweeper's interval is off unless a test asks for
 * it: tests call sweepOnce() themselves, so nothing happens behind their back.
 */
export async function createTestWorker(
  overrides: Record<string, string> = {},
  options: StartWorkerOptions = {},
): Promise<TestWorker> {
  const env = testEnv(overrides);
  const app = await startWorker(env, { runSweeper: false, shutdownTimeoutMs: 5000, ...options });
  return {
    app,
    ctx: app.ctx,
    env,
    prisma: app.ctx.prisma,
    async close() {
      await Promise.all([app.fanoutWorker.close(), app.deliveryWorker.close()]);
      await app.ctx.fanoutQueue.obliterate({ force: true }).catch(() => {});
      await app.ctx.deliveryQueue.obliterate({ force: true }).catch(() => {});
      await app.shutdown();
    },
  };
}

export const SAMPLE_BODY = '{"type":"order.created","data":{"id":"ord_123","amount":250}}';

export interface TestDestination {
  id: string;
  connectionId: string;
  /** The plaintext `whsec_` signing secret, to verify what the receiver got. */
  signingSecret: string;
}

export interface TestTenant {
  id: string;
  sourceId: string;
  /** Adds a destination and a connection from the tenant's source to it. */
  addDestination(options: {
    url: string;
    enabled?: boolean;
    connectionEnabled?: boolean;
    filter?: Prisma.InputJsonValue | null;
  }): Promise<TestDestination>;
  /** Stores an Event the way ingestion does (status RECEIVED), without going through the api. */
  createEvent(options?: {
    body?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
    receivedAt?: Date;
  }): Promise<Event>;
  /** Stores a Delivery the way fan-out or replay does (status PENDING), without a job. */
  createDelivery(
    event: Event,
    destination: TestDestination,
    overrides?: Partial<Prisma.DeliveryUncheckedCreateInput>,
  ): Promise<Delivery>;
  /** Deletes the tenant; everything it owns goes with it (ON DELETE CASCADE). */
  remove(): Promise<void>;
}

export async function createTenant(prisma: PrismaClient, env: Env): Promise<TestTenant> {
  const masterKey = parseMasterKey(env.SECRETS_MASTER_KEY);
  const tenant = await prisma.tenant.create({ data: { name: `test-${randomUUID()}` } });
  const slug = `src-${randomUUID().slice(0, 12)}`;
  const source = await prisma.source.create({
    data: {
      tenantId: tenant.id,
      name: slug,
      slug,
      verificationMode: 'none',
      verificationConfig: { mode: 'none' },
    },
  });

  return {
    id: tenant.id,
    sourceId: source.id,

    async addDestination(options) {
      const signingSecret = generateWhsecSecret();
      const destination = await prisma.destination.create({
        data: {
          tenantId: tenant.id,
          name: `dest-${randomUUID().slice(0, 8)}`,
          url: options.url,
          enabled: options.enabled ?? true,
          signingSecretEnc: encryptSecret(signingSecret, masterKey, {
            tenantId: tenant.id,
            purpose: 'destination-secret',
          }),
        },
      });
      const connection = await prisma.connection.create({
        data: {
          tenantId: tenant.id,
          name: `conn-${randomUUID().slice(0, 8)}`,
          sourceId: source.id,
          destinationId: destination.id,
          enabled: options.connectionEnabled ?? true,
          ...(options.filter === undefined || options.filter === null
            ? {}
            : { filter: options.filter }),
        },
      });
      return { id: destination.id, connectionId: connection.id, signingSecret };
    },

    createEvent(options = {}) {
      const body = options.body ?? SAMPLE_BODY;
      return prisma.event.create({
        data: {
          tenantId: tenant.id,
          sourceId: source.id,
          contentType: 'application/json',
          headers: options.headers ?? { 'content-type': 'application/json' },
          query: options.query ?? {},
          body,
          bodyBytes: Buffer.byteLength(body),
          ...(options.receivedAt ? { receivedAt: options.receivedAt } : {}),
        },
      });
    },

    createDelivery(event, destination, overrides = {}) {
      return prisma.delivery.create({
        data: {
          tenantId: tenant.id,
          eventId: event.id,
          connectionId: destination.connectionId,
          destinationId: destination.id,
          maxAttempts: env.DELIVERY_MAX_ATTEMPTS,
          ...overrides,
        },
      });
    },

    async remove() {
      await prisma.tenant.delete({ where: { id: tenant.id } });
    },
  };
}

/** Enqueues the fan-out job of an event, as the api does after storing it. */
export function enqueueEvent(ctx: WorkerContext, event: Event): Promise<void> {
  return enqueueFanout(ctx.fanoutQueue, { eventId: event.id, tenantId: event.tenantId });
}

/** Enqueues the job of a Delivery, as fan-out and replay do. */
export function enqueueDeliveryJob(ctx: WorkerContext, delivery: Delivery): Promise<void> {
  return enqueueDelivery(
    ctx.deliveryQueue,
    { deliveryId: delivery.id, eventId: delivery.eventId, tenantId: delivery.tenantId },
    delivery.maxAttempts,
  );
}

export type DeliveryWithAttempts = Delivery & { attempts: DeliveryAttempt[] };

/** The deliveries of an event with their attempts, both oldest first. */
export function deliveriesOf(
  prisma: PrismaClient,
  eventId: string,
): Promise<DeliveryWithAttempts[]> {
  return prisma.delivery.findMany({
    where: { eventId },
    include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    orderBy: { id: 'asc' },
  });
}

/** Polls until the delivery is SUCCEEDED or DEAD and returns it with its attempts. */
export function waitForTerminalDelivery(
  prisma: PrismaClient,
  deliveryId: string,
  timeoutMs = 15_000,
): Promise<DeliveryWithAttempts> {
  return eventually(
    async () => {
      const delivery = await prisma.delivery.findUnique({
        where: { id: deliveryId },
        include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
      });
      return delivery && (delivery.status === 'SUCCEEDED' || delivery.status === 'DEAD')
        ? delivery
        : null;
    },
    { timeoutMs },
  );
}

/** A logger that keeps its lines in memory, so a test can assert on what the worker logged. */
export function captureLogger(level = 'debug'): {
  logger: Logger;
  raw: () => string;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level, name: 'worker', destination });
  return {
    logger,
    raw: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Polls until `check` returns a value, instead of sleeping for a fixed time. */
export async function eventually<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
