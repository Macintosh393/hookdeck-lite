// The api's handle on the `delivery` queue, used by replay: a replay is a new Delivery row plus
// a job for it. Pipeline position: api (replay) -> [delivery queue] -> delivery processor.
// The Queue is created lazily (lazy-queue.ts), because the api starts even when Redis is down.
import { Inject, Injectable } from '@nestjs/common';
import { createDeliveryQueue, enqueueDeliveries, QUEUE_DELIVERY } from '@hdl/core';
import type { DeliveryJobData, DeliveryQueue, Env, Logger, Redis } from '@hdl/core';
import { ENV, LOGGER, REDIS } from '../tokens.js';
import { LazyQueue } from './lazy-queue.js';

@Injectable()
export class DeliveryProducer {
  private readonly lazy: LazyQueue<DeliveryQueue>;

  constructor(@Inject(REDIS) redis: Redis, @Inject(ENV) env: Env, @Inject(LOGGER) logger: Logger) {
    this.lazy = new LazyQueue(redis, logger, QUEUE_DELIVERY, () =>
      createDeliveryQueue({
        connection: redis,
        prefix: env.BULLMQ_PREFIX,
        // Fail fast instead of waiting for Redis (see fanout-producer.ts).
        skipWaitingForReady: true,
      }),
    );
  }

  /** The queue, or null while Redis has not been reachable since the api started. */
  get queue(): DeliveryQueue | null {
    return this.lazy.queue;
  }

  /**
   * Adds one job per Delivery, with jobId = Delivery.id, in one round trip. Rejects quickly
   * when Redis is down; the rows stay PENDING and the sweeper enqueues them.
   */
  async enqueue(
    deliveries: ReadonlyArray<{ data: DeliveryJobData; maxAttempts: number }>,
  ): Promise<void> {
    await enqueueDeliveries(this.lazy.require(), deliveries);
  }

  close(): Promise<void> {
    return this.lazy.close();
  }
}
