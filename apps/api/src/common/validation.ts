// Input checks shared by the management controllers: a query string against its Zod schema, and
// path ids. A failure becomes the API's one error shape (docs/api/openapi.yaml, ErrorResponse).
import { validateInput } from '@hdl/shared';
import type { InputSchema, ParsedInput } from '@hdl/shared';
import { ApiError } from './api-error.js';

/** Returns the parsed value, or throws `400 VALIDATION_ERROR` naming each field that failed. */
export function parseOrThrow<Schema extends InputSchema>(
  schema: Schema,
  value: unknown,
): ParsedInput<Schema> {
  const result = validateInput(schema, value);
  if (!result.ok) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {}, result.details);
  }
  return result.value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export const notFound = (): ApiError => new ApiError(404, 'NOT_FOUND', 'Resource not found.');

/**
 * A path id that is not a UUID cannot name a row, so it is a 404 like any other unknown id.
 * Checking here also keeps a malformed value away from Postgres, which would reject the query
 * with an error of its own (and that would surface as a 500).
 */
export function requireUuid(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}
