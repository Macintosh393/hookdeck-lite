// The root NestJS module: wires the shared connections, the error filter and the controllers
// together: ingestion, the probes, and the management API (/api/v1) behind the ApiKeyGuard.
// Day 2 has whoami, the read endpoints for events and deliveries, and replay; CRUD, metrics and
// the stream follow on Day 3.
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Env, Logger } from '@hdl/core';
import { ApiKeyGuard } from './auth/api-key.guard.js';
import { WhoamiController } from './auth/whoami.controller.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { DeliveriesController } from './deliveries/deliveries.controller.js';
import { DeliveriesService } from './deliveries/deliveries.service.js';
import { ReplayService } from './deliveries/replay.service.js';
import { EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
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
      controllers: [
        HealthController,
        IngestController,
        WhoamiController,
        EventsController,
        DeliveriesController,
      ],
      providers: [
        SourceCache,
        IngestService,
        ApiKeyGuard,
        EventsService,
        DeliveriesService,
        ReplayService,
        // APP_FILTER registers the filter globally and lets it use dependency injection.
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
