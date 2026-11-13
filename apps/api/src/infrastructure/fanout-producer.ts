// The api's handle on the `fanout` queue. It exists because a BullMQ Queue must not be created
// while Redis is unreachable, and the api has to start (and accept webhooks) even then.
// Pipeline position: the hand-over from ingest to fan-out.
import { Inject, Injectable } from '@nestjs/common';
import { createFanoutQueue, enqueueFanout } from '@hdl/core';
import type { Env, FanoutJobData, FanoutQueue, Logger, Redis } from '@hdl/core';
import { ENV, LOGGER, REDIS } from '../tokens.js';

@Injectable()
export class FanoutProducer {
  private currentQueue: FanoutQueue | null = null;
  private closed = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.createQueueWhenRedisIsReady();
  }

  /** The queue, or null while Redis has not been reachable since the api started. */
  get queue(): FanoutQueue | null {
    return this.currentQueue;
  }

  /** Adds the fan-out job for an event. Rejects quickly when Redis is down; the caller logs and moves on. */
  async enqueue(data: FanoutJobData): Promise<void> {
    if (this.currentQueue === null) {
      throw new Error('Redis has not been reachable since the api started');
    }
    await enqueueFanout(this.currentQueue, data);
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

    const queue = createFanoutQueue({
      connection: this.redis,
      prefix: this.env.BULLMQ_PREFIX,
      // Without this, add() first waits for the connection's `ready` event, which does not
      // come while Redis is down, so the request would hang instead of failing fast.
      skipWaitingForReady: true,
    });
    this.currentQueue = queue;

    queue.waitUntilReady().catch((error: unknown) => {
      // The connection dropped between `ready` and the version check. Start over.
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'The fanout queue could not initialise; it will be created again when Redis is back',
      );
      if (this.currentQueue === queue) this.currentQueue = null;
      void queue.close().catch(() => {});
      this.redis.once('ready', () => this.createQueueWhenRedisIsReady());
    });
  }
}
