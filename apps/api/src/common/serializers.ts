// Turns database rows into the JSON shapes of docs/api/openapi.yaml. Every response of the
// management API goes through one of these, so a column that is not listed here (tenantId, an
// encrypted secret, updatedAt) cannot leak into a response by accident.
import type {
  Delivery as DeliveryRow,
  DeliveryAttempt as AttemptRow,
  Event as EventRow,
} from '@hdl/database';
import type {
  AttemptErrorCode,
  DeadReason,
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  Event,
  EventDetail,
} from '@hdl/shared';

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** A jsonb column that holds a flat object: stored headers (strings) or a query (strings and lists). */
function asRecord<Value = string>(value: unknown): Record<string, Value> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Value>)
    : {};
}

/** The columns of an Event that list responses carry: everything except the stored request. */
export const EVENT_SUMMARY_SELECT = {
  id: true,
  sourceId: true,
  status: true,
  externalEventId: true,
  contentType: true,
  bodyBytes: true,
  deliveryCount: true,
  filteredCount: true,
  failureReason: true,
  receivedAt: true,
  fannedOutAt: true,
} as const;

export type EventSummaryRow = Pick<EventRow, keyof typeof EVENT_SUMMARY_SELECT>;

export function toEvent(row: EventSummaryRow): Event {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status,
    externalEventId: row.externalEventId,
    contentType: row.contentType,
    bodyBytes: row.bodyBytes,
    deliveryCount: row.deliveryCount,
    filteredCount: row.filteredCount,
    failureReason: row.failureReason,
    receivedAt: iso(row.receivedAt),
    fannedOutAt: isoOrNull(row.fannedOutAt),
  };
}

export function toEventDetail(row: EventRow & { deliveries: DeliveryRow[] }): EventDetail {
  return {
    ...toEvent(row),
    // Sensitive headers were replaced with "[redacted]" before the event was stored.
    headers: asRecord(row.headers),
    query: asRecord<string | string[]>(row.query),
    body: row.body,
    deliveries: row.deliveries.map(toDelivery),
  };
}

export function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    eventId: row.eventId,
    connectionId: row.connectionId,
    destinationId: row.destinationId,
    status: row.status,
    trigger: row.trigger,
    replayOfId: row.replayOfId,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: isoOrNull(row.nextAttemptAt),
    lastAttemptAt: isoOrNull(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastErrorCode: row.lastErrorCode,
    deadReason: row.deadReason as DeadReason | null,
    completedAt: isoOrNull(row.completedAt),
    createdAt: iso(row.createdAt),
  };
}

export function toDeliveryAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    attemptNumber: row.attemptNumber,
    outcome: row.outcome,
    statusCode: row.statusCode,
    errorCode: row.errorCode as AttemptErrorCode | null,
    errorMessage: row.errorMessage,
    startedAt: iso(row.startedAt),
    durationMs: row.durationMs,
    retryAfterMs: row.retryAfterMs,
    resolvedIp: row.resolvedIp,
    // The worker stored these with the signature already replaced by "[redacted]".
    requestHeaders: asRecord(row.requestHeaders),
    responseHeaders: row.responseHeaders === null ? null : asRecord(row.responseHeaders),
    responseBody: row.responseBody,
    responseBodyTruncated: row.responseBodyTruncated,
  };
}

export function toDeliveryDetail(row: DeliveryRow & { attempts: AttemptRow[] }): DeliveryDetail {
  return { ...toDelivery(row), attempts: row.attempts.map(toDeliveryAttempt) };
}
