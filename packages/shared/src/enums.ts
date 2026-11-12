// The canonical enum values of hookdeck-lite, as plain string unions that also work in the browser.
// Spellings are fixed by docs/ARCHITECTURE.md#canonical-names. Do not add or rename a value here
// without changing that table in the same commit.

export const EVENT_STATUSES = ['RECEIVED', 'FANNED_OUT', 'FAILED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const DELIVERY_STATUSES = ['PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_TRIGGERS = ['EVENT', 'REPLAY'] as const;
export type DeliveryTrigger = (typeof DELIVERY_TRIGGERS)[number];

export const ATTEMPT_OUTCOMES = ['SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const VERIFICATION_MODES = ['standard-webhooks', 'generic-hmac', 'none'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export const DEAD_REASONS = ['RETRIES_EXHAUSTED', 'PERMANENT_FAILURE', 'STALLED'] as const;
export type DeadReason = (typeof DEAD_REASONS)[number];

export const ATTEMPT_ERROR_CODES = [
  'TIMEOUT',
  'NETWORK_ERROR',
  'DNS_ERROR',
  'TLS_ERROR',
  'SSRF_BLOCKED',
  'REDIRECT_NOT_FOLLOWED',
  'HTTP_ERROR',
] as const;
export type AttemptErrorCode = (typeof ATTEMPT_ERROR_CODES)[number];

/** Set on `Delivery.lastErrorCode` when a delivery is stopped without making an attempt. */
export const DESTINATION_DISABLED = 'DESTINATION_DISABLED';

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_SIGNATURE',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'DESTINATION_URL_NOT_ALLOWED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const STREAM_MESSAGE_TYPES = [
  'event.received',
  'event.fanned_out',
  'delivery.created',
  'delivery.attempted',
] as const;
export type StreamMessageType = (typeof STREAM_MESSAGE_TYPES)[number];
