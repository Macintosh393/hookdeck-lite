// The fan-out processor: turns one Event into one Delivery per matching connection.
// Pipeline position: ingest -> [fan-out] -> delivery -> stream.
// The numbered steps are the ones in docs/QUEUES.md#fan-out-processor (sequence diagram 2).
import { enqueueDeliveries, publishStreamMessage } from '@hdl/core';
import type { FanoutJobData, Job, Logger } from '@hdl/core';
import { evaluateFilter, parseFilter } from '@hdl/shared';
import type { FilterInput } from '@hdl/shared';
import type { WorkerContext } from '../context.js';

/** The stored request in the shape the filter engine evaluates. */
export function buildFilterInput(event: {
  body: string;
  headers: unknown;
  query: unknown;
}): FilterInput {
  const asRecord = <T>(value: unknown): Record<string, T> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, T>)
      : {};
  return {
    // Ingestion only accepts valid JSON, so this cannot throw for a stored event. If it ever
    // does, the job fails and is retried like any other bug (the "poison payload" case).
    body: JSON.parse(event.body) as unknown,
    headers: asRecord<string>(event.headers),
    query: asRecord<string | string[]>(event.query),
  };
}

/**
 * True when the event should go through this connection. Never throws (AC6.3): a stored filter
 * that does not validate is treated as "no match" and logged, because guessing in either
 * direction could deliver events to the wrong place.
 */
export function connectionMatches(
  connection: { id: string; filter: unknown },
  input: FilterInput,
  log: Logger,
): boolean {
  if (connection.filter === null || connection.filter === undefined) return true;
  try {
    const parsed = parseFilter(connection.filter);
    if (!parsed.ok) {
      log.warn(
        { connectionId: connection.id, issues: parsed.issues },
        'Stored filter is invalid; treating it as no match',
      );
      return false;
    }
    return evaluateFilter(parsed.filter, input);
  } catch (error) {
    log.warn(
      { connectionId: connection.id, err: error instanceof Error ? error.message : String(error) },
      'Filter evaluation failed; treating it as no match',
    );
    return false;
  }
}

export async function processFanout(ctx: WorkerContext, job: Job<FanoutJobData>): Promise<void> {
  const { eventId, tenantId } = job.data;
  const log = ctx.logger.child({ tenantId, eventId });

  // 1. Load the Event. Missing, or no longer RECEIVED: someone already handled it.
  const event = await ctx.prisma.event.findUnique({ where: { id: eventId } });
  if (event === null || event.status !== 'RECEIVED') {
    log.debug({ status: event?.status ?? null }, 'Fan-out skipped: the event is not RECEIVED');
    return;
  }

  // 2. Enabled connections of the event's source whose destination is enabled too.
  const connections = await ctx.prisma.connection.findMany({
    where: { sourceId: event.sourceId, enabled: true, destination: { enabled: true } },
    select: { id: true, destinationId: true, filter: true },
    orderBy: { id: 'asc' },
  });

  // 3. Parse the body once, then evaluate each connection's filter against it.
  const input = buildFilterInput(event);
  const matching = connections.filter((connection) => connectionMatches(connection, input, log));
  const deliveryCount = matching.length;
  const filteredCount = connections.length - matching.length;
  const fannedOutAt = new Date();

  // 4. Flip the status and create the Deliveries in one transaction.
  const deliveries = await ctx.prisma.$transaction(async (tx) => {
    // LEARN: compare-and-set. The WHERE repeats the status we read in step 1, so of two runs of
    // this job (the api and the sweeper can both enqueue an event) only one updates a row. The
    // other sees count 0 and stops, which is what makes fan-out idempotent (AC5.3).
    // See docs/DATA-MODEL.md#event-status
    const flipped = await tx.event.updateMany({
      where: { id: eventId, status: 'RECEIVED' },
      data: { status: 'FANNED_OUT', deliveryCount, filteredCount, fannedOutAt },
    });
    if (flipped.count === 0) return null;
    if (matching.length === 0) return [];

    return tx.delivery.createManyAndReturn({
      data: matching.map((connection) => ({
        tenantId: event.tenantId,
        eventId: event.id,
        connectionId: connection.id,
        destinationId: connection.destinationId,
        status: 'PENDING' as const,
        trigger: 'EVENT' as const,
        maxAttempts: ctx.env.DELIVERY_MAX_ATTEMPTS,
      })),
      select: { id: true, destinationId: true, maxAttempts: true },
    });
  });
  if (deliveries === null) {
    log.debug('Fan-out skipped: another run fanned the event out first');
    return;
  }

  // 5. One delivery job per Delivery. If this throws, BullMQ retries the job, step 1 then
  //    returns early (the Event is FANNED_OUT), and the sweeper enqueues the PENDING Deliveries.
  await enqueueDeliveries(
    ctx.deliveryQueue,
    deliveries.map((delivery) => ({
      data: { deliveryId: delivery.id, eventId: event.id, tenantId: event.tenantId },
      maxAttempts: delivery.maxAttempts,
    })),
  );

  // 6. Tell the live stream. Best effort: publishStreamMessage never throws.
  const at = fannedOutAt.toISOString();
  await publishStreamMessage(ctx.publisher, log, event.tenantId, {
    type: 'event.fanned_out',
    at,
    data: { eventId: event.id, deliveryCount, filteredCount },
  });
  for (const delivery of deliveries) {
    await publishStreamMessage(ctx.publisher, log, event.tenantId, {
      type: 'delivery.created',
      at,
      data: {
        deliveryId: delivery.id,
        eventId: event.id,
        destinationId: delivery.destinationId,
        trigger: 'EVENT',
        replayOfId: null,
      },
    });
  }

  log.info({ deliveryCount, filteredCount }, 'Event fanned out');
}
