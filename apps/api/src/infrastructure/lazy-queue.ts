// A BullMQ Queue that is created only once Redis is reachable. Both of the api's producers
// (fanout for ingestion, delivery for replay) use it, because the api has to start, and accept
// webhooks, while Redis is down. The reasons are in docs/QUEUES.md#redis-connections.
import type { Logger, Redis } from '@hdl/core';

/** The two things this file needs from a BullMQ Queue. */
interface ClosableQueue {
  waitUntilReady(): Promise<unknown>;
  close(): Promise<void>;
}

export class LazyQueue<Q extends ClosableQueue> {
  private currentQueue: Q | null = null;
  private closed = false;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    /** For the log line: 'fanout' or 'delivery'. */
    private readonly queueName: string,
    private readonly createQueue: () => Q,
  ) {
    this.createQueueWhenRedisIsReady();
  }

  /** The queue, or null while Redis has not been reachable since the api started. */
  get queue(): Q | null {
    return this.currentQueue;
  }

  /** The queue, or an error that the caller treats like any other failed Redis call. */
  require(): Q {
    if (this.currentQueue === null) {
      throw new Error('Redis has not been reachable since the api started');
    }
    return this.currentQueue;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.currentQueue?.close();
  }

  /**
   * A new Queue immediately asks Redis for its version, once. If that one command fails, the
   * Queue stays broken: every later add() waits forever, even after Redis is back. (Found on
   * Day 1; see docs/QUEUES.md#redis-connections.) So the Queue is created only when the
   * connection is ready, and replaced if its start-up check still fails.
   */
  private createQueueWhenRedisIsReady(): void {
    if (this.closed) return;
    if (this.redis.status !== 'ready') {
      this.redis.once('ready', () => this.createQueueWhenRedisIsReady());
      return;
    }

    const queue = this.createQueue();
    this.currentQueue = queue;

    queue.waitUntilReady().catch((error: unknown) => {
      // The connection dropped between `ready` and the version check. Start over.
      this.logger.warn(
        { queue: this.queueName, err: error instanceof Error ? error.message : String(error) },
        'A queue could not initialise; it will be created again when Redis is back',
      );
      if (this.currentQueue === queue) this.currentQueue = null;
      void queue.close().catch(() => {});
      this.redis.once('ready', () => this.createQueueWhenRedisIsReady());
    });
  }
}
