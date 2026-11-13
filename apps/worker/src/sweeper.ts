// The sweeper: a reconciler that compares what Postgres says should be in progress with what
// Redis actually has, and repairs the difference. Pipeline position: beside the processors.
// It is what makes a 202 survive a Redis outage: an Event or Delivery that never got a job
// (or lost it) is enqueued again from its row. Spec: docs/QUEUES.md#sweeper, sequence diagram 6.
// Why a setInterval and not a BullMQ Job Scheduler: docs/adr/0004-ingestion-durability.md
import { enqueueDelivery, enqueueFanout } from '@hdl/core';
import type { Job, Queue } from '@hdl/core';
import type { WorkerContext } from './context.js';
import { markDeliveryDead, markEventFailed } from './failed-listeners.js';

/** Rows looked at per kind and per tick: at most 300 rows in total. */
const SWEEP_BATCH_SIZE = 100;

export interface SweepCounts {
  /** No job existed: one was added. */
  enqueued: number;
  /** The job is waiting, delayed, active or prioritized: nothing to do. */
  inProgress: number;
  /** The job is in BullMQ's failed set: the row was marked FAILED or DEAD. */
  markedTerminal: number;
  /** The job completed but the row is not terminal: a bug, logged. */
  inconsistent: number;
}

export interface SweepResult {
  events: SweepCounts;
  deliveries: SweepCounts;
}

const emptyCounts = (): SweepCounts => ({
  enqueued: 0,
  inProgress: 0,
  markedTerminal: 0,
  inconsistent: 0,
});

type JobSituation = 'missing' | 'in-progress' | 'failed' | 'completed';

/** Where the job of a row is right now. */
async function jobSituation(
  queue: Queue,
  id: string,
): Promise<{ situation: JobSituation; job?: Job }> {
  const job = (await queue.getJob(id)) as Job | undefined;
  if (!job) return { situation: 'missing' };
  const state = await job.getState();
  if (state === 'failed') return { situation: 'failed', job };
  if (state === 'completed') return { situation: 'completed', job };
  // 'unknown': the job was removed between getJob and getState. Treat it as gone.
  if (state === 'unknown') return { situation: 'missing' };
  // waiting, delayed, active, prioritized, waiting-children
  return { situation: 'in-progress', job };
}

export interface SweepOptions {
  /** The current time. Tests pass a later one, so rows count as stuck without anyone waiting. */
  now?: Date;
  /**
   * Limits the pass to one tenant. The worker never sets it: a pass covers every tenant. The
   * integration tests do, because test files run in parallel against one shared database and
   * an unscoped pass would pick up, and deliver, the rows of the other files.
   */
  tenantId?: string;
}

/**
 * One pass. Safe to run twice, or in two worker processes at once: enqueues are deduplicated by
 * the job id, and the status updates are compare-and-set. Throws if Redis or Postgres is down;
 * startSweeper catches that and waits for the next tick.
 */
export async function sweepOnce(
  ctx: WorkerContext,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const stuckBefore = new Date(now.getTime() - ctx.env.SWEEPER_STUCK_AFTER_MS);
  const scope = options.tenantId === undefined ? {} : { tenantId: options.tenantId };
  const result: SweepResult = { events: emptyCounts(), deliveries: emptyCounts() };

  // Events that were stored but never fanned out (the enqueue at ingestion failed).
  const stuckEvents = await ctx.prisma.event.findMany({
    where: { ...scope, status: 'RECEIVED', receivedAt: { lt: stuckBefore } },
    select: { id: true, tenantId: true },
    orderBy: { receivedAt: 'asc' },
    take: SWEEP_BATCH_SIZE,
  });
  for (const event of stuckEvents) {
    const log = ctx.logger.child({ tenantId: event.tenantId, eventId: event.id });
    const { situation, job } = await jobSituation(ctx.fanoutQueue, event.id);
    if (situation === 'missing') {
      await enqueueFanout(ctx.fanoutQueue, { eventId: event.id, tenantId: event.tenantId });
      log.info('Sweeper enqueued a stuck event');
      result.events.enqueued += 1;
    } else if (situation === 'failed') {
      const reason = job?.failedReason ?? 'The fan-out job failed';
      if (await markEventFailed(ctx, event.id, reason)) {
        log.error({ err: reason }, 'Sweeper marked an event FAILED: its job is in the failed set');
      }
      result.events.markedTerminal += 1;
    } else if (situation === 'completed') {
      log.warn('Fan-out job completed but the event is still RECEIVED');
      result.events.inconsistent += 1;
    } else {
      result.events.inProgress += 1;
    }
  }

  // Deliveries without a job: PENDING ones (a crash between the fan-out commit and addBulk, or
  // a replay while Redis was down) and RETRYING ones whose next attempt is overdue (Redis lost
  // its data, or the delayed job vanished).
  const select = { id: true, tenantId: true, eventId: true, maxAttempts: true } as const;
  const stuckPending = await ctx.prisma.delivery.findMany({
    where: { ...scope, status: 'PENDING', createdAt: { lt: stuckBefore } },
    select,
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH_SIZE,
  });
  const stuckRetrying = await ctx.prisma.delivery.findMany({
    where: { ...scope, status: 'RETRYING', nextAttemptAt: { lt: stuckBefore } },
    select,
    orderBy: { nextAttemptAt: 'asc' },
    take: SWEEP_BATCH_SIZE,
  });
  for (const delivery of [...stuckPending, ...stuckRetrying]) {
    const log = ctx.logger.child({
      tenantId: delivery.tenantId,
      eventId: delivery.eventId,
      deliveryId: delivery.id,
    });
    const { situation, job } = await jobSituation(ctx.deliveryQueue, delivery.id);
    if (situation === 'missing') {
      await enqueueDelivery(
        ctx.deliveryQueue,
        { deliveryId: delivery.id, eventId: delivery.eventId, tenantId: delivery.tenantId },
        delivery.maxAttempts,
      );
      log.info('Sweeper enqueued a stuck delivery');
      result.deliveries.enqueued += 1;
    } else if (situation === 'failed') {
      if (await markDeliveryDead(ctx, delivery.id)) {
        log.warn(
          { err: job?.failedReason },
          'Sweeper marked a delivery DEAD: its job is in the failed set',
        );
      }
      result.deliveries.markedTerminal += 1;
    } else if (situation === 'completed') {
      log.warn('Delivery job completed but the delivery is not terminal');
      result.deliveries.inconsistent += 1;
    } else {
      result.deliveries.inProgress += 1;
    }
  }

  return result;
}

export interface Sweeper {
  /** Stops the interval and waits for a pass that is running to finish. */
  stop(): Promise<void>;
}

/** Runs sweepOnce every SWEEPER_INTERVAL_MS. A pass that is still running is never overlapped. */
export function startSweeper(
  ctx: WorkerContext,
  options: Pick<SweepOptions, 'tenantId'> = {},
): Sweeper {
  let running: Promise<void> | null = null;

  const tick = (): void => {
    if (running !== null) return; // the previous pass is still at work (slow Redis or Postgres)
    running = sweepOnce(ctx, options)
      .then((result) => {
        const touched =
          result.events.enqueued +
          result.events.markedTerminal +
          result.deliveries.enqueued +
          result.deliveries.markedTerminal;
        if (touched > 0) ctx.logger.info({ sweep: result }, 'Sweeper pass repaired stuck work');
      })
      .catch((error: unknown) => {
        // Redis or Postgres is down. Nothing is lost: the rows are still there next tick.
        ctx.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Sweeper pass failed; it will try again on the next tick',
        );
      })
      .finally(() => {
        running = null;
      });
  };

  const timer = setInterval(tick, ctx.env.SWEEPER_INTERVAL_MS);
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
