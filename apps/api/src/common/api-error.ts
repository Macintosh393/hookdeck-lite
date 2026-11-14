// The error our own code throws when a request must fail with a specific status and code.
// The exception filter turns it into the ErrorResponse shape of docs/api/openapi.yaml.
import type { ApiErrorCode } from '@hdl/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Extra response headers, e.g. Retry-After on a 429. */
    readonly headers: Record<string, string> = {},
    /** Which fields failed validation, for a 400. Sent as `error.details`. */
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
