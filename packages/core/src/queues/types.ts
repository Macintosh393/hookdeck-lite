// Queue names, job names and job payloads: the contract between whoever adds a job (api, sweeper,
// fan-out) and the worker that processes it. Copied from docs/QUEUES.md#job-payloads; keep them in step.
// Payloads carry ids only. Bodies and secrets stay in Postgres.

export const QUEUE_FANOUT = 'fanout' as const;
export const QUEUE_DELIVERY = 'delivery' as const;

export const JOB_FANOUT_EVENT = 'fanout.event' as const;
export const JOB_DELIVERY_ATTEMPT = 'delivery.attempt' as const;

/** One per Event. jobId = eventId. */
export interface FanoutJobData {
  eventId: string;
  tenantId: string;
}

/** One per Delivery, re-run for each retry. jobId = deliveryId. */
export interface DeliveryJobData {
  deliveryId: string;
  eventId: string;
  tenantId: string;
}

/** Thrown by the delivery processor when another attempt should be made. */
export class RetryableDeliveryError extends Error {
  constructor(
    message: string,
    /** The delay the processor already computed and stored as Delivery.nextAttemptAt. */
    public readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RetryableDeliveryError';
  }
}
