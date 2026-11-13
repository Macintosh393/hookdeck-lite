// Publishes live-stream messages to Redis pub/sub. Pipeline position: the last stage, "stream".
// The api publishes `event.received` and replay's `delivery.created`; the worker publishes the rest.
// The receiving side is subscriber.ts. Decision: docs/adr/0011-live-stream.md
import type { StreamMessage } from '@hdl/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** The pub/sub channel of one tenant. Canonical name: docs/ARCHITECTURE.md#canonical-names */
export function streamChannel(tenantId: string): string {
  return `hdl:stream:${tenantId}`;
}

/**
 * Publishes one message, best effort. Pub/sub stores nothing: if nobody is subscribed, or Redis
 * is down, the message is gone, and that is fine because the dashboard refetches over REST.
 * So this never throws. It returns whether Redis accepted the message.
 */
export async function publishStreamMessage(
  redis: Redis,
  logger: Logger,
  tenantId: string,
  message: StreamMessage,
): Promise<boolean> {
  try {
    await redis.publish(streamChannel(tenantId), JSON.stringify(message));
    return true;
  } catch (error) {
    logger.debug(
      { tenantId, type: message.type, err: error instanceof Error ? error.message : String(error) },
      'Could not publish a stream message',
    );
    return false;
  }
}
