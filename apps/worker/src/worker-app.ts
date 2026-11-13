// Wires the worker together: connections, the two BullMQ Workers, their failed listeners, the
// sweeper, and graceful shutdown. main.ts calls startWorker() and handles the process signals;
// the integration tests call it too and run the whole worker inside the test process.
// Spec: docs/QUEUES.md (worker settings, backoff strategy wiring, graceful shutdown).
import {
  computeBackoffDelay,
  createDeliveryQueue,
  createFanoutQueue,
  createLogger,
  createSafeHttpClient,
  createWorkerConnection,
  createWorkerProducerConnection,
  JOB_DELIVERY_ATTEMPT,
  JOB_FANOUT_EVENT,
  parseMasterKey,
  QUEUE_DELIVERY,
  QUEUE_FANOUT,
  RetryableDeliveryError,
  Worker,
} from '@hdl/core';
import type { DeliveryJobData, Env, FanoutJobData, Logger, Redis, SafeHttpClient } from '@hdl/core';
import { createPrismaClient } from '@hdl/database';
import type { WorkerContext } from './context.js';
import { processDelivery } from './delivery/delivery.processor.js';
import { onDeliveryJobFailed, onFanoutJobFailed } from './failed-listeners.js';
import { processFanout } from './fanout/fanout.processor.js';
import { startSweeper } from './sweeper.js';
import type { Sweeper } from './sweeper.js';

/**
 * How long shutdown waits for active jobs. Under the platform's kill deadline (30 s on Render)
 * and above DELIVERY_TIMEOUT_MS (15 s), so every in-flight attempt can finish and be recorded.
 */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

export interface StartWorkerOptions {
  /** Tests pass a logger that writes to memory. Default: stdout, pretty in development. */
  logger?: Logger;
  /** Tests may pass their own client (for example one with a stub DNS resolver). */
  httpClient?: SafeHttpClient;
  /** Source of randomness for the backoff jitter. Default: Math.random. */
  random?: () => number;
  /** False keeps the sweeper interval off; tests then call sweepOnce() themselves. Default: true. */
  runSweeper?: boolean;
  /** Tests only: limits the sweeper to one tenant (see SweepOptions.tenantId). */
  sweepTenantId?: string;
  /** Default: SHUTDOWN_TIMEOUT_MS. Tests shorten it. */
  shutdownTimeoutMs?: number;
  /** BullMQ's stalled-job settings. Defaults: 30 s, 30 s, 1 (docs/QUEUES.md#worker-settings). */
  stalled?: { lockDuration?: number; stalledInterval?: number; maxStalledCount?: number };
}

export type FanoutWorker = Worker<FanoutJobData, void, typeof JOB_FANOUT_EVENT>;
export type DeliveryWorker = Worker<DeliveryJobData, void, typeof JOB_DELIVERY_ATTEMPT>;

export interface WorkerApp {
  ctx: WorkerContext;
  fanoutWorker: FanoutWorker;
  deliveryWorker: DeliveryWorker;
  /**
   * Stops taking jobs, waits for the active ones, then closes every connection. Safe to call
   * more than once: later calls return the first call's promise.
   */
  shutdown(): Promise<void>;
}

/**
 * A Worker repeats its Redis connection's errors as `error` events, and an `error` event without
 * a listener crashes Node. During an outage they arrive several times a second, so only the
 * first one in each 30 seconds is logged.
 */
function logWorkerErrors(
  worker: { on(event: 'error', listener: (error: Error) => void): unknown },
  logger: Logger,
  queue: string,
): void {
  let lastLoggedAt = 0;
  worker.on('error', (error) => {
    const now = Date.now();
    if (now - lastLoggedAt < 30_000) return;
    lastLoggedAt = now;
    logger.warn({ queue, err: error.message }, 'BullMQ worker error');
  });
}

async function closeRedis(connection: Redis): Promise<void> {
  // quit() lets Redis finish what is in flight; if Redis is down it fails, and disconnect() is enough.
  await connection.quit().catch(() => connection.disconnect());
}

export async function startWorker(env: Env, options: StartWorkerOptions = {}): Promise<WorkerApp> {
  const logger =
    options.logger ??
    createLogger({ level: env.LOG_LEVEL, name: 'worker', pretty: env.NODE_ENV === 'development' });

  if (env.NODE_ENV === 'production' && env.SSRF_ALLOWLIST.length > 0) {
    logger.warn(
      { hosts: env.SSRF_ALLOWLIST },
      'SSRF_ALLOWLIST is not empty in production: these hosts skip the address check',
    );
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  // Two connections, as in docs/QUEUES.md#redis-connections: one for the Workers (blocking
  // commands, retried forever) and one for adding jobs and publishing.
  const workerConnection = createWorkerConnection(env.REDIS_URL, logger);
  const producerConnection = createWorkerProducerConnection(env.REDIS_URL, logger);
  const prefix = env.BULLMQ_PREFIX;

  const ctx: WorkerContext = {
    env,
    logger,
    prisma,
    masterKey: parseMasterKey(env.SECRETS_MASTER_KEY),
    fanoutQueue: createFanoutQueue({ connection: producerConnection, prefix }),
    deliveryQueue: createDeliveryQueue({ connection: producerConnection, prefix }),
    publisher: producerConnection,
    httpClient:
      options.httpClient ??
      createSafeHttpClient({
        allowlist: env.SSRF_ALLOWLIST,
        timeoutMs: env.DELIVERY_TIMEOUT_MS,
        maxResponseBytes: env.DELIVERY_MAX_RESPONSE_BYTES,
      }),
    random: options.random ?? Math.random,
  };

  // LEARN: stalled jobs. A Worker holds a lock on each active job and renews it every
  // lockDuration / 2. If this process dies, the lock expires, and a stalled-check (every
  // stalledInterval, in any worker) puts the job back in the queue. A job that stalls more than
  // maxStalledCount times is failed without running. See docs/learning/bullmq-101.md#stalled-jobs
  const stalledSettings = {
    lockDuration: options.stalled?.lockDuration ?? 30_000,
    stalledInterval: options.stalled?.stalledInterval ?? 30_000,
    maxStalledCount: options.stalled?.maxStalledCount ?? 1,
  };

  const fanoutWorker: FanoutWorker = new Worker(QUEUE_FANOUT, (job) => processFanout(ctx, job), {
    connection: workerConnection,
    prefix,
    concurrency: env.FANOUT_CONCURRENCY,
    ...stalledSettings,
  });

  // LEARN: backoffStrategy lives on the Worker, not on the Queue or the job. BullMQ calls it
  // after the processor throws and passes the error, so the delay the processor computed (and
  // stored as nextAttemptAt) travels inside the error. See docs/learning/bullmq-101.md#retries
  const deliveryWorker: DeliveryWorker = new Worker(
    QUEUE_DELIVERY,
    (job) => processDelivery(ctx, job),
    {
      connection: workerConnection,
      prefix,
      concurrency: env.DELIVERY_CONCURRENCY,
      ...stalledSettings,
      settings: {
        backoffStrategy: (attemptsMade, _type, error) =>
          error instanceof RetryableDeliveryError
            ? error.delayMs
            : // An unexpected exception (a bug, Postgres down): no stored delay, so compute one.
              computeBackoffDelay({
                attemptNumber: attemptsMade,
                retryAfterMs: null,
                baseMs: env.BACKOFF_BASE_MS,
                capMs: env.BACKOFF_CAP_MS,
                random: ctx.random,
              }),
      },
    },
  );

  logWorkerErrors(fanoutWorker, logger, QUEUE_FANOUT);
  logWorkerErrors(deliveryWorker, logger, QUEUE_DELIVERY);
  fanoutWorker.on('failed', (job, error) => void onFanoutJobFailed(ctx, job, error));
  deliveryWorker.on('failed', (job, error) => void onDeliveryJobFailed(ctx, job, error));
  fanoutWorker.on('stalled', (jobId) => logger.warn({ queue: QUEUE_FANOUT, jobId }, 'Job stalled'));
  deliveryWorker.on('stalled', (jobId) =>
    logger.warn({ queue: QUEUE_DELIVERY, jobId }, 'Job stalled; it will run again'),
  );

  // Resolves once both Workers have their connections. Throws if Redis cannot be reached at all.
  await Promise.all([fanoutWorker.waitUntilReady(), deliveryWorker.waitUntilReady()]);

  const sweeper: Sweeper | null =
    options.runSweeper === false
      ? null
      : startSweeper(ctx, options.sweepTenantId ? { tenantId: options.sweepTenantId } : {});
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  logger.info(
    {
      deliveryConcurrency: env.DELIVERY_CONCURRENCY,
      fanoutConcurrency: env.FANOUT_CONCURRENCY,
      maxAttempts: env.DELIVERY_MAX_ATTEMPTS,
      backoffBaseMs: env.BACKOFF_BASE_MS,
      backoffCapMs: env.BACKOFF_CAP_MS,
      sweeperIntervalMs: sweeper ? env.SWEEPER_INTERVAL_MS : null,
    },
    'Worker started',
  );

  async function shutDown(): Promise<void> {
    // 1. Stop producing new work.
    logger.info('Worker shutting down: waiting for active jobs');

    // 2. worker.close() stops fetching jobs and resolves when the active ones have finished.
    //    It has no timeout of its own, hence the race.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
    });
    const finished = Promise.all([
      fanoutWorker.close(),
      deliveryWorker.close(),
      sweeper?.stop(),
    ]).then(() => 'finished' as const);
    const outcome = await Promise.race([finished, timeout]);
    clearTimeout(timer);

    // 3. The timeout won: stop waiting. In BullMQ 6.7 a close(true) issued after close() returns
    //    the first call's promise, so it cannot force anything. Dropping the connection does:
    //    the locks are no longer renewed, they expire, and another worker re-runs the jobs
    //    after its next stalled check. A duplicate delivery is possible; nothing is lost.
    if (outcome === 'timeout') {
      logger.warn(
        { shutdownTimeoutMs },
        'Active jobs did not finish in time; exiting anyway. They will be re-run as stalled jobs',
      );
      finished.catch(() => {});
      workerConnection.disconnect();
    }

    // 4. Close what is left: queues, Redis connections, Postgres.
    await ctx.fanoutQueue.close().catch(() => {});
    await ctx.deliveryQueue.close().catch(() => {});
    if (outcome === 'finished') await closeRedis(workerConnection);
    await closeRedis(producerConnection);
    await prisma.$disconnect();
    logger.info('Worker stopped');
  }

  let shuttingDown: Promise<void> | null = null;
  return {
    ctx,
    fanoutWorker,
    deliveryWorker,
    shutdown() {
      shuttingDown ??= shutDown();
      return shuttingDown;
    },
  };
}
