// Sends NestJS's own log lines ("Mapped {/health, GET} route", startup errors) through pino, so
// the api writes one format only. Without it NestJS prints coloured text next to our JSON.
import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@hdl/core';

export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  // NestJS calls these with a message and, as the last argument, the name of the class that logged.
  log(message: unknown, ...rest: unknown[]): void {
    this.logger.info({ context: contextOf(rest) }, String(message));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.logger.warn({ context: contextOf(rest) }, String(message));
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.logger.error({ context: contextOf(rest) }, String(message));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.logger.debug({ context: contextOf(rest) }, String(message));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.logger.trace({ context: contextOf(rest) }, String(message));
  }
}

function contextOf(rest: unknown[]): string | undefined {
  const last = rest.at(-1);
  return typeof last === 'string' ? last : undefined;
}
