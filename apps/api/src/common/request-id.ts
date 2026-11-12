// Request ids: every request gets one, it is returned as the x-request-id header, it is on every
// log line of the request, and it is in every error body. Decision: docs/adr/0015-observability.md
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** What we accept from a caller: short, and nothing that could break a log line or a header. */
const SANE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Keeps the caller's x-request-id if it is sane, otherwise makes a new one. */
export function resolveRequestId(headerValue: string | string[] | undefined): string {
  if (typeof headerValue === 'string' && SANE_REQUEST_ID.test(headerValue)) return headerValue;
  return randomUUID();
}

/**
 * Fastify calls this for every incoming request, before routing and before the body is parsed,
 * and uses the result as `request.id`. So even a request that fails in the body parser has an
 * id, and Fastify's logger binds it to every log line of the request.
 */
export function assignRequestId(rawRequest: { headers: IncomingHttpHeaders }): string {
  return resolveRequestId(rawRequest.headers[REQUEST_ID_HEADER]);
}
