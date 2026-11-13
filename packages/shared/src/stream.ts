// The messages published to the live stream (Redis pub/sub channel hdl:stream:{tenantId}) and
// forwarded to the dashboard over SSE. Pipeline position: the last stage, "stream".
// The api and the worker publish these; the dashboard parses them. Spec: docs/QUEUES.md#job-payloads

export type StreamMessage =
  | { type: 'event.received'; at: string; data: { eventId: string; sourceId: string } }
  | {
      type: 'event.fanned_out';
      at: string;
      data: { eventId: string; deliveryCount: number; filteredCount: number };
    }
  | {
      type: 'delivery.created';
      at: string;
      data: {
        deliveryId: string;
        eventId: string;
        destinationId: string;
        trigger: 'EVENT' | 'REPLAY';
        replayOfId: string | null;
      };
    }
  | {
      type: 'delivery.attempted';
      at: string;
      data: {
        deliveryId: string;
        eventId: string;
        destinationId: string;
        attemptNumber: number;
        outcome: 'SUCCESS' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE';
        statusCode: number | null;
        errorCode: string | null;
        durationMs: number;
        status: 'RETRYING' | 'SUCCEEDED' | 'DEAD';
        nextAttemptAt: string | null;
      };
    };
