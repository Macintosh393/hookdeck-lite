// The backstop for jobs that fail without their processor writing a final state.
// Pipeline position: beside fan-out and delivery. Normally the delivery processor marks a Delivery
// DEAD itself, in the same transaction as the last attempt. These listeners cover what it cannot:
// a job BullMQ fails on its own (stalled too often), or one whose processor kept throwing
// unexpectedly. Spec: docs/QUEUES.md#stalled-jobs
import { UnrecoverableError } from '@hdl/core';
import type { DeliveryJobData, FanoutJobData, Job } from '@hdl/core';
import type { DeadReason } from '@hdl/shared';
import { OPEN_DELIVERY_STATUSES } from './context.js';
import type { WorkerContext } from './context.js';

/** The failedReason BullMQ gives a job that stalled more than `maxStalledCount` times. */
export const STALLED_LIMIT_MESSAGE = 'job stalled more than allowable limit';

const MAX_FAILURE_REASON_LENGTH = 500;

/**
 * BullMQ fires `failed` after every failed attempt, also when the job will be retried (verified:
 * U8 in docs/PLAN.md). This is true only when the job will not run again.
 */
export function isFinalFailure(
  job: Pick<Job, 'attemptsMade' | 'opts'> | undefined,
  error: Error,
): boolean {
  if (error instanceof UnrecoverableError || error.name === 'UnrecoverableError') return true;
  if (error.message === STALLED_LIMIT_MESSAGE) return true;
  if (job === undefined) return false;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * The dead reason for a Delivery whose job died in BullMQ without a final attempt being
 * recorded. The failed listener and the sweeper use the same rule, so the result does not
 * depend on which of them notices first.
 */
export function deadReasonForFailedJob(delivery: {
  attemptCount: number;
  maxAttempts: number;
}): DeadReason {
  return delivery.attemptCount >= delivery.maxAttempts ? 'RETRIES_EXHAUSTED' : 'STALLED';
}

/** Marks a Delivery DEAD if it is still open. Returns whether a row changed. */
export async function markDeliveryDead(ctx: WorkerContext, deliveryId: string): Promise<boolean> {
  const delivery = await ctx.prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: { attemptCount: true, maxAttempts: true },
  });
  if (delivery === null) return false;

  // The same guard as in the processor: a Delivery that reached SUCCEEDED or DEAD meanwhile
  // matches no row and stays as it is.
  const updated = await ctx.prisma.delivery.updateMany({
    where: { id: deliveryId, status: { in: [...OPEN_DELIVERY_STATUSES] } },
    data: {
      status: 'DEAD',
      deadReason: deadReasonForFailedJob(delivery),
      nextAttemptAt: null,
      completedAt: new Date(),
    },
  });
  return updated.count > 0;
}

/** Marks an Event FAILED if it is still RECEIVED. Returns whether a row changed. */
export async function markEventFailed(
  ctx: WorkerContext,
  eventId: string,
  reason: string,
): Promise<boolean> {
  const updated = await ctx.prisma.event.updateMany({
    where: { id: eventId, status: 'RECEIVED' },
    data: { status: 'FAILED', failureReason: reason.slice(0, MAX_FAILURE_REASON_LENGTH) },
  });
  return updated.count > 0;
}

/** `failed` listener of the delivery Worker. */
export async function onDeliveryJobFailed(
  ctx: WorkerContext,
  job: Job<DeliveryJobData> | undefined,
  error: Error,
): Promise<void> {
  // `job` is undefined only when BullMQ already removed the failed job. Then there is no id to
  // act on, and the sweeper will find the Delivery without a job and enqueue it again.
  if (job === undefined || !isFinalFailure(job, error)) return;
  const { deliveryId, eventId, tenantId } = job.data;
  const log = ctx.logger.child({ tenantId, eventId, deliveryId });
  try {
    // In the usual case the processor already wrote DEAD and this changes nothing.
    if (await markDeliveryDead(ctx, deliveryId)) {
      log.warn({ err: error.message }, 'Delivery job failed without a final attempt; marked DEAD');
    }
  } catch (dbError) {
    // Postgres is unreachable. The sweeper finds the failed job later and does the same.
    log.error({ err: dbError }, 'Could not mark the delivery DEAD; the sweeper will');
  }
}

/** `failed` listener of the fan-out Worker. */
export async function onFanoutJobFailed(
  ctx: WorkerContext,
  job: Job<FanoutJobData> | undefined,
  error: Error,
): Promise<void> {
  if (job === undefined || !isFinalFailure(job, error)) return;
  const { eventId, tenantId } = job.data;
  const log = ctx.logger.child({ tenantId, eventId });
  try {
    if (await markEventFailed(ctx, eventId, error.message)) {
      log.error({ err: error.message }, 'Fan-out failed for the last time; event marked FAILED');
    }
  } catch (dbError) {
    log.error({ err: dbError }, 'Could not mark the event FAILED; the sweeper will');
  }
}
