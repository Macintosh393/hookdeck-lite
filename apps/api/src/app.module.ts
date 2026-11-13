// The root NestJS module: wires the shared connections, the error filter and the controllers
// together. Day 1 has ingestion and the probes; the management API is added on Day 2 and 3.
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Env, Logger } from '@hdl/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { HealthController } from './health/health.controller.js';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestService } from './ingest/ingest.service.js';
import { SourceCache } from './ingest/source-cache.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';

@Module({})
export class AppModule {
  static forRoot(
    env: Env,
    logger: Logger,
    options: { redisReadyTimeoutMs: number },
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [InfrastructureModule.forRoot(env, logger, options)],
      controllers: [HealthController, IngestController],
      providers: [
        SourceCache,
        IngestService,
        // APP_FILTER registers the filter globally and lets it use dependency injection.
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
