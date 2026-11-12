// The JSON shapes the HTTP API returns, shared by the api (which produces them) and the dashboard
// (which reads them). Each type mirrors a schema of the same name in docs/api/openapi.yaml.
// Timestamps are ISO-8601 strings here; the database row types live in @hdl/database.
import type {
  ApiErrorCode,
  AttemptErrorCode,
  AttemptOutcome,
  DeadReason,
  DeliveryStatus,
  DeliveryTrigger,
  EventStatus,
  VerificationMode,
} from './enums.js';
import type { VerificationConfig } from './schemas/verification-config.js';

/** The single error shape of the API. `requestId` is also sent as the x-request-id header. */
export interface ErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Array<{ path: string; message: string }>;
    requestId: string;
  };
}

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

/** Response of `POST /in/{sourceSlug}`. `duplicate` carries the id of the event stored first. */
export interface IngestResponse {
  id: string;
  status: 'accepted' | 'duplicate';
}

export interface HealthResponse {
  status: 'ok';
}

export interface Readiness {
  status: 'ok' | 'unavailable';
  checks: {
    postgres: 'ok' | 'fail';
    redis: 'ok' | 'fail';
  };
}

export interface Whoami {
  tenant: { id: string; name: string; ingestRateLimit: number };
  apiKey: { prefix: string; name: string };
}

export interface Source {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  verificationMode: VerificationMode;
  verificationConfig: VerificationConfig;
  dedupeHeader: string | null;
  /** The secret itself is never returned by any endpoint. */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Destination {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned only by create and rotate-secret: the one time the signing secret is shown. */
export interface DestinationWithSecret extends Destination {
  signingSecret: string;
}

export interface Connection {
  id: string;
  name: string;
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  /** A filter rule (docs/FILTER-RULES.md), or null to match every event. */
  filter: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface Event {
  id: string;
  sourceId: string;
  status: EventStatus;
  externalEventId: string | null;
  contentType: string;
  bodyBytes: number;
  deliveryCount: number;
  filteredCount: number;
  failureReason: string | null;
  receivedAt: string;
  fannedOutAt: string | null;
}

export interface EventDetail extends Event {
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  /** The request body exactly as received. */
  body: string;
  deliveries: Delivery[];
}

export interface Delivery {
  id: string;
  eventId: string;
  connectionId: string | null;
  destinationId: string;
  status: DeliveryStatus;
  trigger: DeliveryTrigger;
  replayOfId: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  deadReason: DeadReason | null;
  completedAt: string | null;
  createdAt: string;
}

export interface DeliveryDetail extends Delivery {
  attempts: DeliveryAttempt[];
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  outcome: AttemptOutcome;
  statusCode: number | null;
  errorCode: AttemptErrorCode | null;
  errorMessage: string | null;
  startedAt: string;
  durationMs: number;
  retryAfterMs: number | null;
  resolvedIp: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  responseBodyTruncated: boolean;
}

export interface BulkReplayResponse {
  replayedCount: number;
  hasMore: boolean;
}
