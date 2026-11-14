// Builds the signed request of one delivery attempt: the Standard Webhooks headers plus our own.
// Pipeline position: delivery, just before the HTTP call. Pure functions, so they are unit-tested.
// Spec: docs/SECURITY.md#outbound-signing
import { REDACTED, signStandardWebhook } from '@hdl/core';

export const OUTBOUND_USER_AGENT = 'hookdeck-lite/1.0';

export interface OutboundRequestInput {
  /** Event.id: becomes `webhook-id`, the same for every attempt and every replay of the event. */
  eventId: string;
  /** Event.body, sent and signed byte for byte. */
  body: string;
  /** The Event's original content type. */
  contentType: string;
  deliveryId: string;
  /** 1-based. */
  attemptNumber: number;
  /** The destination's decrypted `whsec_` secret. */
  signingSecret: string;
  /** When this attempt is sent, in Unix seconds. Not the event's time: see the comment below. */
  timestampSeconds: number;
}

/** The headers of one attempt, in the order of the table in SECURITY.md. */
export function buildOutboundHeaders(input: OutboundRequestInput): Record<string, string> {
  return {
    'webhook-id': input.eventId,
    // The send time of this attempt. Receivers reject timestamps older than their tolerance
    // (5 minutes in the reference library), and our retries can come hours after the event.
    'webhook-timestamp': String(input.timestampSeconds),
    'webhook-signature': signStandardWebhook({
      secret: input.signingSecret,
      id: input.eventId,
      timestampSeconds: input.timestampSeconds,
      body: input.body,
    }),
    'content-type': input.contentType,
    'user-agent': OUTBOUND_USER_AGENT,
    'x-hdl-delivery-id': input.deliveryId,
    'x-hdl-attempt': String(input.attemptNumber),
  };
}

/**
 * The headers as they are stored on the DeliveryAttempt row and shown in the dashboard. The
 * signature is replaced: with it and the body, anyone who can read the row could replay the
 * request to the destination within the receiver's tolerance window.
 */
export function redactOutboundHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'webhook-signature': REDACTED };
}
