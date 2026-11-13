// Everything the worker's processors, listeners and sweeper share: configuration, connections,
// queues and the HTTP client. worker-app.ts builds one WorkerContext at startup and passes it to
// each of them, so they are plain functions that tests can call with their own context.
import type { DeliveryQueue, Env, FanoutQueue, Logger, Redis, SafeHttpClient } from '@hdl/core';
import type { PrismaClient } from '@hdl/database';

export interface WorkerContext {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  /** SECRETS_MASTER_KEY decoded to its 32 bytes. Decrypts destination signing secrets. */
  masterKey: Buffer;
  /** The worker adds to this queue from the sweeper only. */
  fanoutQueue: FanoutQueue;
  /** Fan-out and the sweeper add delivery jobs here. */
  deliveryQueue: DeliveryQueue;
  /** Redis connection used to publish live-stream messages. */
  publisher: Redis;
  /** The only way out to a destination: docs/SECURITY.md#ssrf-protection */
  httpClient: SafeHttpClient;
  /** Source of randomness for the backoff jitter. Math.random, except in tests. */
  random: () => number;
}

/** The two statuses a Delivery can still leave. SUCCEEDED and DEAD are terminal. */
export const OPEN_DELIVERY_STATUSES = ['PENDING', 'RETRYING'] as const;
