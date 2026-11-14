// Receives live-stream messages from Redis pub/sub and hands them to listeners, per tenant.
// Pipeline position: the last stage, "stream". The api's SSE endpoint (Day 3) is the listener.
// One Redis connection serves every tenant; channels are subscribed on the first listener and
// unsubscribed after the last one (reference counting). Decision: docs/adr/0011-live-stream.md
import { STREAM_MESSAGE_TYPES } from '@hdl/shared';
import type { StreamMessage } from '@hdl/shared';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { streamChannel } from './publisher.js';

export type StreamListener = (message: StreamMessage) => void;

export interface StreamSubscriber {
  /**
   * Starts delivering the tenant's messages to `listener`. Resolves with a function that stops
   * it. Rejects, and registers nothing, if Redis refuses the SUBSCRIBE.
   */
  subscribe(tenantId: string, listener: StreamListener): Promise<() => Promise<void>>;
  /** How many listeners a tenant has. Zero means the channel is not subscribed. */
  listenerCount(tenantId: string): number;
  /** Removes every listener and the message handler. The connection is the caller's to close. */
  close(): Promise<void>;
}

/** Parses one pub/sub payload. Returns null for anything that is not a StreamMessage. */
export function parseStreamMessage(raw: string): StreamMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { type, at, data } = value as { type?: unknown; at?: unknown; data?: unknown };
  if (typeof type !== 'string' || !(STREAM_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  if (typeof at !== 'string' || typeof data !== 'object' || data === null) return null;
  return value as StreamMessage;
}

/**
 * `redis` must be a connection used for nothing else: once a connection has run SUBSCRIBE,
 * Redis accepts only subscribe commands on it (createApiSubscriberConnection in redis.ts).
 */
export function createStreamSubscriber(redis: Redis, logger: Logger): StreamSubscriber {
  const listenersByChannel = new Map<string, Set<StreamListener>>();

  const onMessage = (channel: string, raw: string): void => {
    // The channel name contains the tenant id, so a listener can only ever see its own
    // tenant's messages: the lookup below is the isolation boundary (SEC-AUTH-05).
    const listeners = listenersByChannel.get(channel);
    if (!listeners) return;
    const message = parseStreamMessage(raw);
    if (message === null) {
      logger.warn({ channel }, 'Ignored a malformed stream message');
      return;
    }
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (error) {
        // One broken listener (a closed SSE response) must not stop the others.
        logger.warn(
          { channel, err: error instanceof Error ? error.message : String(error) },
          'A stream listener threw',
        );
      }
    }
  };
  redis.on('message', onMessage);

  /** The SUBSCRIBE command of each channel, so listeners that arrive while it is in flight wait for it too. */
  const subscribed = new Map<string, Promise<unknown>>();

  /** Forgets a listener. Returns true when it was the channel's last one. */
  function forget(channel: string, listener: StreamListener): boolean {
    const listeners = listenersByChannel.get(channel);
    if (!listeners || !listeners.delete(listener) || listeners.size > 0) return false;
    listenersByChannel.delete(channel);
    subscribed.delete(channel);
    return true;
  }

  async function remove(channel: string, listener: StreamListener): Promise<void> {
    if (!forget(channel, listener)) return;
    // Last listener gone. If Redis is down the UNSUBSCRIBE fails, which is harmless: messages
    // for a channel without listeners are dropped in onMessage.
    await redis.unsubscribe(channel).catch(() => {});
  }

  return {
    async subscribe(tenantId, listener) {
      const channel = streamChannel(tenantId);
      let listeners = listenersByChannel.get(channel);
      if (listeners === undefined) {
        listeners = new Set();
        listenersByChannel.set(channel, listeners);
        // First listener of this tenant: this is the only SUBSCRIBE sent for the channel.
        subscribed.set(channel, redis.subscribe(channel));
      }
      listeners.add(listener);

      try {
        await subscribed.get(channel);
      } catch (error) {
        forget(channel, listener);
        throw error;
      }
      return () => remove(channel, listener);
    },

    listenerCount(tenantId) {
      return listenersByChannel.get(streamChannel(tenantId))?.size ?? 0;
    },

    async close() {
      redis.off('message', onMessage);
      const channels = [...listenersByChannel.keys()];
      listenersByChannel.clear();
      subscribed.clear();
      if (channels.length > 0) await redis.unsubscribe(...channels).catch(() => {});
    },
  };
}
