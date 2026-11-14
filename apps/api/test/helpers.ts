// Helpers shared by the api's integration tests: building the app, creating a tenant with its
// API keys, sources, destinations, events and deliveries directly in the database, and signing
// requests.
// Isolation rules (docs/TESTING.md#isolation-between-tests): each file has its own tenant and
// its own BULLMQ_PREFIX, and deletes both when it is done.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createLogger,
  encryptSecret,
  generateWhsecSecret,
  hashApiKey,
  parseEnv,
  parseMasterKey,
  signStandardWebhook,
} from '@hdl/core';
import type { DeliveryQueue, Env, FanoutQueue, Logger } from '@hdl/core';
import type { Delivery, DeliveryAttempt, Event, Prisma, PrismaClient } from '@hdl/database';
import type { VerificationConfig } from '@hdl/shared';
import { createApp } from '../src/create-app.js';
import { DeliveryProducer } from '../src/infrastructure/delivery-producer.js';
import { FanoutProducer } from '../src/infrastructure/fanout-producer.js';
import { PRISMA } from '../src/tokens.js';

/** The test environment (.env.test) with a queue prefix no other test file uses. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    ...process.env,
    BULLMQ_PREFIX: `hdl-test-${randomUUID().slice(0, 8)}`,
    ...overrides,
  });
}

export interface TestApp {
  app: NestFastifyApplication;
  env: Env;
  prisma: PrismaClient;
  /** The api's own fanout queue. Throws if Redis has not been reachable since the app started. */
  readonly fanoutQueue: FanoutQueue;
  /** The api's own delivery queue (replay adds to it). Throws like fanoutQueue. */
  readonly deliveryQueue: DeliveryQueue;
  /** Removes the queues' keys from Redis and closes the app. */
  close(): Promise<void>;
}

export async function createTestApp(
  overrides: Record<string, string> = {},
  options: { logger?: Logger; redisReadyTimeoutMs?: number } = {},
): Promise<TestApp> {
  const env = testEnv(overrides);
  const app = await createApp(env, options);
  const producer = app.get(FanoutProducer);
  const deliveryProducer = app.get(DeliveryProducer);
  return {
    app,
    env,
    prisma: app.get<PrismaClient>(PRISMA),
    get fanoutQueue() {
      if (producer.queue === null) throw new Error('The app has no fanout queue: Redis is down');
      return producer.queue;
    },
    get deliveryQueue() {
      if (deliveryProducer.queue === null) {
        throw new Error('The app has no delivery queue: Redis is down');
      }
      return deliveryProducer.queue;
    },
    async close() {
      // An app whose Redis was never reachable has no queue and left nothing behind.
      await producer.queue?.obliterate({ force: true }).catch(() => {});
      await deliveryProducer.queue?.obliterate({ force: true }).catch(() => {});
      await app.close();
    },
  };
}

/** A URL (Redis or Postgres) on a port nothing listens on: "the dependency is down". */
export async function closedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface TestSource {
  id: string;
  slug: string;
  /** The plaintext secret, or null for mode `none`. */
  secret: string | null;
}

export interface TestApiKey {
  id: string;
  /** The plaintext key, `hdl_<prefix>_<secret>`. Only the test knows it; the database has its hash. */
  key: string;
  prefix: string;
  /** inject() headers that authenticate as this key. */
  headers: { authorization: string };
}

export interface TestDestination {
  id: string;
  connectionId: string;
  /** The plaintext `whsec_` signing secret. */
  signingSecret: string;
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphanumeric(length: number): string {
  return Array.from(randomBytes(length), (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join(
    '',
  );
}

export interface TestTenant {
  id: string;
  /** Creates an API key for the tenant, stored as the seed script stores it (prefix + SHA-256). */
  addApiKey(options?: { revoked?: boolean; name?: string }): Promise<TestApiKey>;
  /** Adds a destination and a connection from `source` to it. */
  addDestination(
    source: TestSource,
    options?: { url?: string; enabled?: boolean },
  ): Promise<TestDestination>;
  /** Stores an Event the way ingestion does, without going through POST /in. */
  createEvent(
    source: TestSource,
    overrides?: Partial<Prisma.EventUncheckedCreateInput>,
  ): Promise<Event>;
  /** Stores a Delivery the way fan-out does (PENDING unless overridden), without a job. */
  createDelivery(
    event: Event,
    destination: TestDestination,
    overrides?: Partial<Prisma.DeliveryUncheckedCreateInput>,
  ): Promise<Delivery>;
  /** Stores one attempt of a delivery, as the worker records it. */
  addAttempt(
    delivery: Delivery,
    attemptNumber: number,
    overrides?: Partial<Prisma.DeliveryAttemptUncheckedCreateInput>,
  ): Promise<DeliveryAttempt>;
  /** Adds a source to the tenant. Default: standard-webhooks with a fresh whsec_ secret. */
  addSource(options?: {
    config?: VerificationConfig;
    secret?: string | null;
    dedupeHeader?: string | null;
    enabled?: boolean;
  }): Promise<TestSource>;
  /** Deletes the tenant; its sources and events go with it (ON DELETE CASCADE). */
  remove(): Promise<void>;
}

export async function createTenant(
  prisma: PrismaClient,
  env: Env,
  options: { ingestRateLimit?: number } = {},
): Promise<TestTenant> {
  const masterKey = parseMasterKey(env.SECRETS_MASTER_KEY);
  const tenant = await prisma.tenant.create({
    data: { name: `test-${randomUUID()}`, ingestRateLimit: options.ingestRateLimit ?? 100_000 },
  });

  return {
    id: tenant.id,
    async addSource(sourceOptions = {}) {
      const config = sourceOptions.config ?? { mode: 'standard-webhooks' };
      const defaultSecret = config.mode === 'none' ? null : generateWhsecSecret();
      const secret = sourceOptions.secret === undefined ? defaultSecret : sourceOptions.secret;
      const defaultDedupe = config.mode === 'standard-webhooks' ? 'webhook-id' : null;
      const slug = `src-${randomUUID().slice(0, 12)}`;

      const source = await prisma.source.create({
        data: {
          tenantId: tenant.id,
          name: slug,
          slug,
          enabled: sourceOptions.enabled ?? true,
          verificationMode: config.mode,
          verificationConfig: config,
          secretEnc:
            secret === null
              ? null
              : encryptSecret(secret, masterKey, { tenantId: tenant.id, purpose: 'source-secret' }),
          dedupeHeader:
            sourceOptions.dedupeHeader === undefined ? defaultDedupe : sourceOptions.dedupeHeader,
        },
      });
      return { id: source.id, slug, secret };
    },
    async addApiKey(keyOptions = {}) {
      const prefix = randomAlphanumeric(8);
      const key = `hdl_${prefix}_${randomAlphanumeric(32)}`;
      const row = await prisma.apiKey.create({
        data: {
          tenantId: tenant.id,
          name: keyOptions.name ?? 'Test key',
          prefix,
          keyHash: hashApiKey(key),
          revokedAt: keyOptions.revoked ? new Date() : null,
        },
      });
      return { id: row.id, key, prefix, headers: { authorization: `Bearer ${key}` } };
    },
    async addDestination(source, destinationOptions = {}) {
      const signingSecret = generateWhsecSecret();
      const destination = await prisma.destination.create({
        data: {
          tenantId: tenant.id,
          name: `dest-${randomUUID().slice(0, 8)}`,
          url: destinationOptions.url ?? 'http://127.0.0.1:9/hook/unused',
          enabled: destinationOptions.enabled ?? true,
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
        },
      });
      return { id: destination.id, connectionId: connection.id, signingSecret };
    },
    createEvent(source, overrides = {}) {
      return prisma.event.create({
        data: {
          tenantId: tenant.id,
          sourceId: source.id,
          contentType: 'application/json',
          headers: { 'content-type': 'application/json' },
          query: {},
          body: SAMPLE_BODY,
          bodyBytes: Buffer.byteLength(SAMPLE_BODY),
          ...overrides,
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
    addAttempt(delivery, attemptNumber, overrides = {}) {
      return prisma.deliveryAttempt.create({
        data: {
          tenantId: tenant.id,
          deliveryId: delivery.id,
          attemptNumber,
          outcome: 'RETRYABLE_FAILURE',
          statusCode: 503,
          errorCode: 'HTTP_ERROR',
          errorMessage: 'Destination responded with 503.',
          startedAt: new Date(),
          durationMs: 12,
          resolvedIp: '127.0.0.1',
          requestHeaders: {
            'webhook-id': delivery.eventId,
            'webhook-signature': '[redacted]',
            'x-hdl-attempt': String(attemptNumber),
          },
          responseHeaders: { 'content-type': 'text/plain' },
          responseBody: 'Service Unavailable',
          ...overrides,
        },
      });
    },
    async remove() {
      await prisma.tenant.delete({ where: { id: tenant.id } });
    },
  };
}

export const SAMPLE_BODY = '{"type":"order.created","data":{"id":"ord_123","amount":250}}';

export interface SignedRequestOptions {
  body?: string;
  /** The webhook-id. Default: a new one, so requests are not duplicates of each other. */
  id?: string;
  timestampSeconds?: number;
  /** Extra or replacement headers. `undefined` removes a header. */
  headers?: Record<string, string | undefined>;
  query?: string;
}

/** inject() options for a correctly signed Standard Webhooks request to a source. */
export function signedRequest(source: TestSource, options: SignedRequestOptions = {}) {
  if (source.secret === null) throw new Error('signedRequest needs a source with a secret');
  const body = options.body ?? SAMPLE_BODY;
  const id = options.id ?? `msg_${randomUUID()}`;
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': signStandardWebhook({ secret: source.secret, id, timestampSeconds, body }),
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }

  return {
    method: 'POST' as const,
    url: `/in/${source.slug}${options.query ?? ''}`,
    headers,
    payload: body,
  };
}

/** A logger that keeps its lines in memory, so a test can assert on what the app logged. */
export function captureLogger() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', name: 'api', destination });
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
  { timeoutMs = 5000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
