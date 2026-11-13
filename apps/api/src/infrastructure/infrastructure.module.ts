// Creates the api's long-lived connections (Postgres, Redis, the two queues) once, offers them
// to every module (plain values under the tokens in tokens.ts), and closes them on shutdown.
import { Global, Inject, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import {
  createApiProducerConnection,
  createRateLimiter,
  parseMasterKey,
  waitForRedisReady,
} from '@hdl/core';
import type { Env, Logger, Redis } from '@hdl/core';
import { createPrismaClient } from '@hdl/database';
import type { PrismaClient } from '@hdl/database';
import { ENV, LOGGER, MASTER_KEY, PRISMA, RATE_LIMITER, REDIS } from '../tokens.js';
import { DeliveryProducer } from './delivery-producer.js';
import { FanoutProducer } from './fanout-producer.js';

// @Global: the providers are visible to every module without importing this one again.
@Global()
@Module({})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly fanoutProducer: FanoutProducer,
    private readonly deliveryProducer: DeliveryProducer,
  ) {}

  static forRoot(
    env: Env,
    logger: Logger,
    options: { redisReadyTimeoutMs: number },
  ): DynamicModule {
    return {
      module: InfrastructureModule,
      providers: [
        { provide: ENV, useValue: env },
        { provide: LOGGER, useValue: logger },
        { provide: MASTER_KEY, useFactory: () => parseMasterKey(env.SECRETS_MASTER_KEY) },
        { provide: PRISMA, useFactory: () => createPrismaClient(env.DATABASE_URL) },
        {
          provide: REDIS,
          // An async factory: NestJS waits for it before it builds anything that needs Redis.
          useFactory: async () => {
            const redis = createApiProducerConnection(env.REDIS_URL, logger);
            // This connection rejects commands until it is connected (it has no offline queue),
            // and BullMQ sends one as soon as a Queue is created. So give Redis a moment. If it
            // is down we start anyway: ingestion only needs Postgres.
            const ready = await waitForRedisReady(redis, options.redisReadyTimeoutMs);
            if (!ready) {
              logger.warn(
                'Redis is not reachable. Starting anyway: events are stored and enqueued later.',
              );
            }
            return redis;
          },
        },
        FanoutProducer,
        DeliveryProducer,
        {
          provide: RATE_LIMITER,
          inject: [REDIS],
          useFactory: (redis: Redis) => createRateLimiter({ redis, logger }),
        },
      ],
      exports: [
        ENV,
        LOGGER,
        MASTER_KEY,
        PRISMA,
        REDIS,
        RATE_LIMITER,
        FanoutProducer,
        DeliveryProducer,
      ],
    };
  }

  /** Runs on app.close(), and on SIGTERM / SIGINT because createApp enables shutdown hooks. */
  async onApplicationShutdown(): Promise<void> {
    // The queues share the Redis connection, so they go first.
    await this.fanoutProducer.close();
    await this.deliveryProducer.close();
    // disconnect() rather than quit(): quit() sends a command, which fails if Redis is down.
    this.redis.disconnect();
    await this.prisma.$disconnect();
  }
}
