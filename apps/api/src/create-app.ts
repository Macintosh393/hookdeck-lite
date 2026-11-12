// Builds the NestJS application. main.ts calls it and listens; the integration tests call it and
// use app.inject(), which runs a request through the whole app without opening a port.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger } from '@hdl/core';
import type { Env, Logger } from '@hdl/core';
import { LogController } from 'fastify';
import { AppModule } from './app.module.js';
import { PinoNestLogger } from './common/nest-logger.js';
import { assignRequestId, REQUEST_ID_HEADER } from './common/request-id.js';

export interface CreateAppOptions {
  /** Tests pass a logger that writes to memory. Default: stdout, pretty in development. */
  logger?: Logger;
  /** How long startup waits for Redis before carrying on without it. Default: 2 seconds. */
  redisReadyTimeoutMs?: number;
}

export async function createApp(
  env: Env,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const logger =
    options.logger ??
    createLogger({ level: env.LOG_LEVEL, name: 'api', pretty: env.NODE_ENV === 'development' });

  const adapter = new FastifyAdapter({
    // Fastify is built on pino. Given our logger, it writes "incoming request" and "request
    // completed" for every request, with method, url and status code. It never logs headers
    // or bodies, which is what keeps signatures and API keys out of the logs.
    loggerInstance: logger,
    genReqId: assignRequestId,
    // The name the request id has on those log lines. The default is "reqId".
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env, logger, { redisReadyTimeoutMs: options.redisReadyTimeoutMs ?? 2000 }),
    adapter,
    {
      // Keeps the untouched request bytes on `request.rawBody`. Signature verification needs
      // them (see the LEARN comment in ingest.controller.ts).
      rawBody: true,
      // NestJS's own log lines go through pino too.
      logger: new PinoNestLogger(logger),
    },
  );

  // Send the request id back on every response, including error responses.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });

  // Re-registers the JSON parser with our body limit. A larger body is answered with 413.
  app.useBodyParser('application/json', { bodyLimit: env.INGEST_MAX_BODY_BYTES });

  app.enableCors({
    origin: env.CORS_ORIGINS,
    // Explicit on purpose: the Fastify CORS default omits PATCH and DELETE, which the dashboard needs.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after'],
  });

  // Makes NestJS call onApplicationShutdown on SIGTERM and SIGINT (Ctrl+C on Windows), so
  // connections are closed and in-flight requests finish. See docs/QUEUES.md#graceful-shutdown
  app.enableShutdownHooks();

  await app.init();
  // Fastify finishes loading its plugins asynchronously; inject() and listen() need that done.
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
