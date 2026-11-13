// Redis connection factories: one per role in docs/QUEUES.md#redis-connections.
// The api and the worker need different failure behaviour from the same Redis, and that behaviour
// is decided entirely by the options passed here.
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { Logger } from 'pino';

/**
 * Opens a connection and wires up logging.
 *
 * ioredis reconnects by itself, forever, and emits an `error` event on every failed try. Two
 * things follow: a connection without an `error` listener crashes the process (Node treats an
 * unhandled `error` event as fatal), and logging each event would print a line every few
 * hundred milliseconds during an outage. So we log only when the state changes: up -> down, down -> up.
 */
function createConnection(url: string, options: RedisOptions, logger: Logger, role: string): Redis {
  const connection = new Redis(url, options);
  let isUp: boolean | null = null; // null = no state reported yet

  connection.on('ready', () => {
    if (isUp !== true) logger.info({ redisRole: role }, 'Redis connection ready');
    isUp = true;
  });
  connection.on('error', (error: Error) => {
    if (isUp !== false) {
      logger.warn({ redisRole: role, err: error.message }, 'Redis connection error; reconnecting');
    }
    isUp = false;
  });
  connection.on('close', () => {
    if (isUp === true) logger.warn({ redisRole: role }, 'Redis connection closed; reconnecting');
    isUp = false;
  });

  return connection;
}

/**
 * The api's connection for Queue instances, the rate limiter and the stream publisher.
 * It fails fast: a webhook provider is waiting for our response, so a Redis outage must turn
 * into a quick error we can ignore, never into a slow request (docs/ARCHITECTURE.md, diagram 1).
 */
export function createApiProducerConnection(url: string, logger: Logger): Redis {
  return createConnection(
    url,
    {
      // Retry a command once, then reject it. The default is 20 retries, which takes seconds.
      maxRetriesPerRequest: 1,
      // By default ioredis queues commands while disconnected and sends them after reconnecting.
      // Off: a command issued while Redis is down is rejected immediately.
      enableOfflineQueue: false,
    },
    logger,
    'api-producer',
  );
}

/**
 * The api's connection for the live stream. A connection that has run SUBSCRIBE can run no
 * other command, so the stream needs one of its own (used from Day 3).
 */
export function createApiSubscriberConnection(url: string, logger: Logger): Redis {
  return createConnection(url, {}, logger, 'api-subscriber');
}

/** The worker's connection for BullMQ Worker instances. */
export function createWorkerConnection(url: string, logger: Logger): Redis {
  return createConnection(
    url,
    {
      // LEARN: a BullMQ Worker waits for jobs with a blocking Redis command. `null` means "retry
      // that command forever", so the worker survives a Redis restart instead of throwing after
      // 20 tries. BullMQ refuses to start a Worker without it. See docs/learning/bullmq-101.md#pitfalls
      maxRetriesPerRequest: null,
    },
    logger,
    'worker',
  );
}

/**
 * The worker's connection for the Queues it adds to (fan-out, sweeper) and for publishing.
 * Defaults: commands wait for Redis to come back, because nothing user-facing blocks on them.
 */
export function createWorkerProducerConnection(url: string, logger: Logger): Redis {
  return createConnection(url, {}, logger, 'worker-producer');
}

/**
 * Waits until the connection can take commands, for at most `timeoutMs`. Returns false on
 * timeout instead of throwing: the api starts without Redis and keeps accepting webhooks.
 */
export function waitForRedisReady(connection: Redis, timeoutMs: number): Promise<boolean> {
  if (connection.status === 'ready') return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      connection.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    connection.once('ready', onReady);
  });
}
