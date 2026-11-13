// The delivery processor: one run of a delivery job is one HTTP attempt for one Delivery.
// Pipeline position: ingest -> fan-out -> [delivery] -> stream.
// The numbered steps are the ones in docs/QUEUES.md#delivery-processor (sequence diagrams 3 and 4).
import {
  classifyResponse,
  computeBackoffDelay,
  decryptSecret,
  parseRetryAfter,
  publishStreamMessage,
  RetryableDeliveryError,
  UnrecoverableError,
} from '@hdl/core';
import type { Classification, DeliveryJobData, Job, Logger, SafeHttpResult } from '@hdl/core';
import { isUniqueViolation } from '@hdl/database';
import type { Delivery, Prisma } from '@hdl/database';
import { DESTINATION_DISABLED } from '@hdl/shared';
import type { DeadReason } from '@hdl/shared';
import { OPEN_DELIVERY_STATUSES } from '../context.js';
import type { WorkerContext } from '../context.js';
import { buildOutboundHeaders, redactOutboundHeaders } from './outbound-request.js';

/** What happens to the Delivery after this attempt. */
type NextState =
  | { status: 'SUCCEEDED' }
  | { status: 'DEAD'; deadReason: DeadReason }
  | { status: 'RETRYING'; delayMs: number };

/** Thrown inside the recording transaction when the Delivery had already left PENDING/RETRYING. */
class DeliveryNoLongerOpenError extends Error {}

/** The line shown in the attempts timeline. Null for a success. */
function describeFailure(result: SafeHttpResult, classification: Classification): string | null {
  if (classification.outcome === 'SUCCESS') return null;
  if (result.kind === 'error') return result.errorMessage;
  if (classification.errorCode === 'REDIRECT_NOT_FOLLOWED') {
    return `Destination responded with ${result.statusCode}. Redirects are not followed.`;
  }
  return `Destination responded with ${result.statusCode}.`;
}

/** Step 5, second half: from the outcome and the attempt number to the Delivery's next status. */
export function decideNextState(input: {
  classification: Classification;
  attemptNumber: number;
  maxAttempts: number;
  retryAfterMs: number | null;
  baseMs: number;
  capMs: number;
  random: () => number;
}): NextState {
  const { classification, attemptNumber } = input;
  if (classification.outcome === 'SUCCESS') return { status: 'SUCCEEDED' };
  if (classification.outcome === 'PERMANENT_FAILURE') {
    return { status: 'DEAD', deadReason: 'PERMANENT_FAILURE' };
  }
  if (attemptNumber >= input.maxAttempts) {
    return { status: 'DEAD', deadReason: 'RETRIES_EXHAUSTED' };
  }
  return {
    status: 'RETRYING',
    delayMs: computeBackoffDelay({
      attemptNumber,
      // Only 429 and 503 may stretch the wait; a Retry-After on, say, a 500 is ignored.
      retryAfterMs: classification.honorsRetryAfter ? input.retryAfterMs : null,
      baseMs: input.baseMs,
      capMs: input.capMs,
      random: input.random,
    }),
  };
}

/**
 * Step 8 for a Delivery whose state was written by someone else (another run of this job, the
 * failed listener, or the sweeper): tell BullMQ whatever matches the row as it is now.
 */
function settleFromCurrentState(delivery: Delivery | null, log: Logger): void {
  if (delivery === null || delivery.status === 'SUCCEEDED') return;
  if (delivery.status === 'DEAD') {
    throw new UnrecoverableError(`Delivery is DEAD (${delivery.deadReason ?? 'unknown reason'})`);
  }
  // RETRYING (or still PENDING): keep the schedule that is stored.
  const delayMs = Math.max(0, (delivery.nextAttemptAt?.getTime() ?? Date.now()) - Date.now());
  log.debug({ delayMs }, 'Another run recorded this attempt; waiting for the stored next attempt');
  throw new RetryableDeliveryError('Attempt already recorded by another run', delayMs);
}

export async function processDelivery(
  ctx: WorkerContext,
  job: Job<DeliveryJobData>,
): Promise<void> {
  const { deliveryId, eventId, tenantId } = job.data;
  const log = ctx.logger.child({ tenantId, eventId, deliveryId });

  // 1. Load the Delivery with its Event and Destination.
  const delivery = await ctx.prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: true, destination: true },
  });
  if (delivery === null) {
    log.warn('Delivery job without a Delivery row (deleted with its destination or event)');
    return;
  }
  // The job id deduplicates enqueues, not processing. A terminal Delivery is never touched again.
  if (delivery.status === 'SUCCEEDED' || delivery.status === 'DEAD') return;

  const { event, destination } = delivery;
  if (!destination.enabled) {
    await ctx.prisma.delivery.updateMany({
      where: { id: deliveryId, status: { in: [...OPEN_DELIVERY_STATUSES] } },
      data: {
        status: 'DEAD',
        deadReason: 'PERMANENT_FAILURE',
        lastErrorCode: DESTINATION_DISABLED,
        nextAttemptAt: null,
        completedAt: new Date(),
      },
    });
    log.info('Delivery stopped without an attempt: the destination is disabled');
    throw new UnrecoverableError('Destination is disabled');
  }

  // 2. Postgres is the attempt counter of record, not job.attemptsMade: after a stalled job or
  //    a Redis wipe the two can differ.
  const attemptNumber = delivery.attemptCount + 1;

  // 3. Build the request: decrypt the signing secret, sign, set the headers.
  const signingSecret = decryptSecret(destination.signingSecretEnc, ctx.masterKey, {
    tenantId: delivery.tenantId,
    purpose: 'destination-secret',
  });
  const startedAt = new Date();
  const headers = buildOutboundHeaders({
    eventId: event.id,
    body: event.body,
    contentType: event.contentType,
    deliveryId,
    attemptNumber,
    signingSecret,
    timestampSeconds: Math.floor(startedAt.getTime() / 1000),
  });

  // 4. Send with the SSRF-safe client. It never throws: a failure is a result too.
  const result = await ctx.httpClient.post({ url: destination.url, headers, body: event.body });

  // LEARN: at-least-once. If the process dies here, the request was sent but nothing is
  // recorded. The job stalls and runs again, and the destination gets the event twice, with the
  // same webhook-id so it can discard the copy. See docs/learning/webhooks-101.md#delivery-guarantees

  // 5. Classify the result and decide what happens next.
  const classification = classifyResponse(
    result.kind === 'response'
      ? { kind: 'response', statusCode: result.statusCode }
      : { kind: 'error', errorCode: result.errorCode },
  );
  const now = new Date();
  const retryAfterMs =
    result.kind === 'response'
      ? parseRetryAfter(result.headers['retry-after'], now.getTime())
      : null;
  const next = decideNextState({
    classification,
    attemptNumber,
    maxAttempts: delivery.maxAttempts,
    retryAfterMs,
    baseMs: ctx.env.BACKOFF_BASE_MS,
    capMs: ctx.env.BACKOFF_CAP_MS,
    random: ctx.random,
  });
  const nextAttemptAt = next.status === 'RETRYING' ? new Date(now.getTime() + next.delayMs) : null;
  const statusCode = result.kind === 'response' ? result.statusCode : null;

  const attemptRow: Prisma.DeliveryAttemptUncheckedCreateInput = {
    tenantId: delivery.tenantId,
    deliveryId,
    attemptNumber,
    outcome: classification.outcome,
    statusCode,
    errorCode: classification.errorCode,
    errorMessage: describeFailure(result, classification),
    startedAt,
    durationMs: result.durationMs,
    retryAfterMs,
    resolvedIp: result.resolvedIp,
    requestHeaders: redactOutboundHeaders(headers),
    ...(result.kind === 'response'
      ? {
          responseHeaders: result.headers,
          responseBody: result.body,
          responseBodyTruncated: result.bodyTruncated,
        }
      : {}),
  };

  // 6. Record the attempt and move the Delivery, in one transaction.
  try {
    await ctx.prisma.$transaction(async (tx) => {
      // The unique index (deliveryId, attemptNumber) makes a second record of the same attempt
      // an error instead of a duplicate row.
      await tx.deliveryAttempt.create({ data: attemptRow });

      // LEARN: compare-and-set. `status IN (PENDING, RETRYING)` is part of the UPDATE, so a
      // Delivery that became SUCCEEDED or DEAD between step 1 and now is not overwritten: the
      // update matches 0 rows and we roll back. Terminal rows never change, which is what
      // keeps the history trustworthy. See docs/DATA-MODEL.md#delivery-status
      const moved = await tx.delivery.updateMany({
        where: { id: deliveryId, status: { in: [...OPEN_DELIVERY_STATUSES] } },
        data: {
          status: next.status,
          attemptCount: attemptNumber,
          lastAttemptAt: startedAt,
          lastStatusCode: statusCode,
          lastErrorCode: classification.errorCode,
          nextAttemptAt,
          deadReason: next.status === 'DEAD' ? next.deadReason : null,
          completedAt: next.status === 'RETRYING' ? null : now,
        },
      });
      if (moved.count === 0) throw new DeliveryNoLongerOpenError();
    });
  } catch (error) {
    if (isUniqueViolation(error) || error instanceof DeliveryNoLongerOpenError) {
      // Reload the Delivery and continue from its current state.
      log.warn(
        { attemptNumber },
        'Attempt not recorded: the delivery was already moved on by another run',
      );
      settleFromCurrentState(
        await ctx.prisma.delivery.findUnique({ where: { id: deliveryId } }),
        log,
      );
      return;
    }
    throw error;
  }

  // 7. Tell the live stream (best effort).
  await publishStreamMessage(ctx.publisher, log, delivery.tenantId, {
    type: 'delivery.attempted',
    at: now.toISOString(),
    data: {
      deliveryId,
      eventId: event.id,
      destinationId: destination.id,
      attemptNumber,
      outcome: classification.outcome,
      statusCode,
      errorCode: classification.errorCode,
      durationMs: result.durationMs,
      status: next.status,
      nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    },
  });

  log.info(
    {
      attemptNumber,
      maxAttempts: delivery.maxAttempts,
      outcome: classification.outcome,
      statusCode,
      errorCode: classification.errorCode,
      durationMs: result.durationMs,
      status: next.status,
      ...(next.status === 'RETRYING' ? { retryInMs: next.delayMs } : {}),
      ...(next.status === 'DEAD' ? { deadReason: next.deadReason } : {}),
    },
    'Delivery attempt recorded',
  );

  // 8. Tell BullMQ. Returning completes the job; the two errors mean "stop" and "run me again".
  const reason = describeFailure(result, classification) ?? 'Delivery failed';
  if (next.status === 'DEAD') {
    // UnrecoverableError moves the job straight to the failed set, whatever attempts BullMQ
    // thinks are left.
    throw new UnrecoverableError(reason);
  }
  if (next.status === 'RETRYING') {
    // The worker's backoffStrategy reads delayMs from this error (worker-app.ts).
    throw new RetryableDeliveryError(reason, next.delayMs);
  }
}
