// Unit tests for error mapping and request ids: every failure must come out in the one error
// shape of docs/api/openapi.yaml, and never leak an internal message.
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { mapException } from './all-exceptions.filter.js';
import { ApiError } from './api-error.js';
import { resolveRequestId } from './request-id.js';

const MAX = 1_048_576;

/** How NestJS hands us a Fastify error: wrapped in an HttpException, the original as `cause`. */
function fastifyError(code: string, statusCode: number, message: string): HttpException {
  const original = Object.assign(new Error(message), { name: 'FastifyError', code, statusCode });
  return new HttpException(message, statusCode, { cause: original });
}

describe('mapException', () => {
  it('passes an ApiError through, with its headers', () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'Rate limit exceeded.', {
      'retry-after': '17',
    });

    expect(mapException(error, MAX)).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded.',
      headers: { 'retry-after': '17' },
    });
  });

  it('maps a body that is too large to 413 PAYLOAD_TOO_LARGE', () => {
    const error = fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413, 'Request body is too large');

    expect(mapException(error, MAX)).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Body exceeds 1048576 bytes.',
    });
  });

  it('maps an unsupported media type to 415 UNSUPPORTED_MEDIA_TYPE', () => {
    const error = fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415, 'Unsupported Media Type: x');

    expect(mapException(error, MAX)).toMatchObject({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Only application/json is accepted.',
    });
  });

  it.each([
    [
      'an empty JSON body',
      fastifyError('FST_ERR_CTP_EMPTY_JSON_BODY', 400, 'Body cannot be empty'),
    ],
    [
      'a wrapped SyntaxError',
      new BadRequestException('x', { cause: new SyntaxError('Unexpected token') }),
    ],
    [
      'a raw SyntaxError with statusCode 400',
      Object.assign(new SyntaxError('bad'), { statusCode: 400 }),
    ],
  ])('maps %s to 400 VALIDATION_ERROR "not valid JSON"', (_label, error) => {
    expect(mapException(error, MAX)).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request body is not valid JSON.',
    });
  });

  it('keeps the message of other 4xx HttpExceptions and maps the status to a code', () => {
    expect(mapException(new BadRequestException('limit must be a number'), MAX)).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'limit must be a number',
    });
    expect(mapException(new NotFoundException('Cannot GET /nope'), MAX)).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Not found.',
    });
  });

  it.each([
    ['a plain Error', new Error('connect ECONNREFUSED 10.0.0.5:5432, password=hunter2')],
    ['a 5xx HttpException', new HttpException('database exploded', 502)],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('maps %s to 500 INTERNAL without echoing its message', (_label, error) => {
    expect(mapException(error, MAX)).toEqual({
      status: 500,
      code: 'INTERNAL',
      message: 'Internal server error.',
      headers: {},
    });
  });
});

describe('resolveRequestId', () => {
  it('keeps a sane id from the caller', () => {
    expect(resolveRequestId('trace-abc.123_X')).toBe('trace-abc.123_X');
  });

  it.each([undefined, '', 'has space', 'x'.repeat(65), 'a\nb', '<b>', ['a', 'b']])(
    'generates a UUID instead of %j',
    (value) => {
      expect(resolveRequestId(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    },
  );
});
