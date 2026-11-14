// The api's handle on the `fanout` queue. Pipeline position: the hand-over from ingest to fan-out.
// The Queue is created lazily (lazy-queue.ts), because the api starts even when Redis is down.
import { Inject, Injectable } from '@nestjs/common';
import { createFanoutQueue, enqueueFanout, QUEUE_FANOUT } from '@hdl/core';
import type { Env, FanoutJobData, FanoutQueue, Logger, Redis } from '@hdl/core';
import { ENV, LOGGER, REDIS } from '../tokens.js';
import { LazyQueue } from './lazy-queue.js';

@Injectable()
export class FanoutProducer {
  private readonly lazy: LazyQueue<FanoutQueue>;

  constructor(@Inject(REDIS) redis: Redis, @Inject(ENV) env: Env, @Inject(LOGGER) logger: Logger) {
    this.lazy = new LazyQueue(redis, logger, QUEUE_FANOUT, () =>
      createFanoutQueue({
        connection: redis,
        prefix: env.BULLMQ_PREFIX,
        // Without this, add() first waits for the connection's `ready` event, which does not
        // come while Redis is down, so the request would hang instead of failing fast.
        skipWaitingForReady: true,
      }),
    );
  }

  /** The queue, or null while Redis has not been reachable since the api started. */
  get queue(): FanoutQueue | null {
    return this.lazy.queue;
  }

  /** Adds the fan-out job for an event. Rejects quickly when Redis is down; the caller logs and moves on. */
  async enqueue(data: FanoutJobData): Promise<void> {
    await enqueueFanout(this.lazy.require(), data);
  }

  close(): Promise<void> {
    return this.lazy.close();
  }
}
