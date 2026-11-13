// Entry point of @hdl/database: the Prisma client factory and the generated types.
// The api and the worker both import from here, so they share one schema and one way to connect.
// Pipeline position: every stage (ingest, fan-out, delivery, stream queries) reads and writes through it.
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

export { Prisma, PrismaClient };
export {
  AttemptOutcome,
  DeliveryStatus,
  DeliveryTrigger,
  EventStatus,
} from './generated/prisma/client.js';
export type {
  ApiKey,
  Connection,
  Delivery,
  DeliveryAttempt,
  Destination,
  Event,
  Source,
  Tenant,
} from './generated/prisma/client.js';

/** How long to wait for a Postgres connection before giving up, in milliseconds. */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Creates a Prisma client that talks to Postgres through the `pg` driver.
 *
 * Prisma 7 has no built-in database driver any more: it needs a "driver adapter". PrismaPg owns a
 * `pg` connection pool; the pool opens connections lazily, on the first query.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    // Without a timeout, a query against an unreachable Postgres waits for the OS to give up,
    // which can take minutes. Ingestion must answer 503 quickly instead (AC1.4).
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  return new PrismaClient({ adapter });
}

/**
 * True when `error` is Postgres rejecting a row because of a unique index.
 *
 * Prisma reports that as a "known request error" with code P2002. Ingestion relies on it for
 * deduplication: the unique index on (sourceId, externalEventId) refuses the second copy of a
 * webhook, and the caller turns this error into a `202 duplicate` response.
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
