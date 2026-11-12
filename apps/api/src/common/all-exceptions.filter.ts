// The one exception filter of the api. Whatever goes wrong, the client gets the single error
// shape of docs/api/openapi.yaml: { error: { code, message, requestId } }.
// It handles three kinds of error: our ApiError, NestJS HttpExceptions (which is also how
// Fastify's body-parser errors arrive), and anything unexpected (500).
import { Catch, HttpException, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Env, Logger } from '@hdl/core';
import type { ApiErrorCode, ErrorResponse } from '@hdl/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV, LOGGER } from '../tokens.js';
import { ApiError } from './api-error.js';

export interface MappedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  headers: Record<string, string>;
}

/** Fastify's codes for "the JSON body could not be parsed". */
const INVALID_JSON_CODES = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
]);

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

function isInvalidJsonError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && INVALID_JSON_CODES.has(code);
}

/** The HTTP status an error asks for, or 500 when it does not ask for a client error. */
function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  // Fastify's JSON parser throws a plain SyntaxError that carries statusCode 400.
  const status = (exception as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return status;
  return 500;
}

/**
 * Decides the response for any thrown value. A pure function, so it can be unit-tested
 * without starting NestJS.
 */
export function mapException(exception: unknown, maxBodyBytes: number): MappedError {
  if (exception instanceof ApiError) {
    return {
      status: exception.status,
      code: exception.code,
      message: exception.message,
      headers: exception.headers,
    };
  }

  const status = statusOf(exception);
  if (status >= 500) {
    // Never echo an internal error message: it can contain SQL, paths or secrets.
    return { status: 500, code: 'INTERNAL', message: 'Internal server error.', headers: {} };
  }

  // NestJS wraps a Fastify error in an HttpException and keeps the original as `cause`.
  const cause = exception instanceof HttpException ? exception.cause : exception;
  const code = CODE_BY_STATUS[status] ?? 'VALIDATION_ERROR';
  let message: string;
  if (status === 413) {
    message = `Body exceeds ${maxBodyBytes} bytes.`;
  } else if (status === 415) {
    message = 'Only application/json is accepted.';
  } else if (status === 404) {
    message = 'Not found.';
  } else if (status === 400 && (isInvalidJsonError(cause) || isInvalidJsonError(exception))) {
    message = 'Request body is not valid JSON.';
  } else {
    message = exception instanceof Error ? exception.message : 'Bad request.';
  }
  return { status, code, message, headers: {} };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = request.id;

    const mapped = mapException(exception, this.env.INGEST_MAX_BODY_BYTES);
    if (mapped.status >= 500) {
      // `err` is pino's key for an error: it logs the message and the stack.
      this.logger.error({ requestId, err: exception }, 'Unhandled error while handling a request');
    }

    const body: ErrorResponse = {
      error: { code: mapped.code, message: mapped.message, requestId },
    };
    void reply.status(mapped.status).headers(mapped.headers).send(body);
  }
}
