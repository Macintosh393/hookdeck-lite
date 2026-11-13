// Unit tests for the stream subscriber's bookkeeping: reference counting, dispatch, bad input.
// They pass a hand-written stand-in for the three Redis methods the subscriber uses, so the
// SUBSCRIBE and UNSUBSCRIBE calls can be counted. The real thing, against the real Redis, is in
// test/stream.int.test.ts.
import { EventEmitter } from 'node:events';
import type { StreamMessage } from '@hdl/shared';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { streamChannel } from './publisher.js';
import { createStreamSubscriber, parseStreamMessage } from './subscriber.js';

const logger = pino({ level: 'silent' });

const received: StreamMessage = {
  type: 'event.received',
  at: '2026-11-13T10:00:00.000Z',
  data: { eventId: 'evt-1', sourceId: 'src-1' },
};

/** A stand-in for a Redis connection in subscriber mode. `emitMessage` plays the server's part. */
function fakeRedis(options: { failSubscribe?: boolean } = {}) {
  const emitter = new EventEmitter();
  const subscribeCalls: string[] = [];
  const unsubscribeCalls: string[] = [];
  const redis = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => emitter.off(event, listener),
    subscribe: (channel: string) => {
      subscribeCalls.push(channel);
      return options.failSubscribe
        ? Promise.reject(new Error('Connection is closed.'))
        : Promise.resolve(1);
    },
    unsubscribe: (...channels: string[]) => {
      unsubscribeCalls.push(...channels);
      return Promise.resolve(0);
    },
  };
  return {
    redis: redis as unknown as Redis,
    subscribeCalls,
    unsubscribeCalls,
    emitMessage: (tenantId: string, payload: unknown) =>
      emitter.emit(
        'message',
        streamChannel(tenantId),
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      ),
    messageListenerCount: () => emitter.listenerCount('message'),
  };
}

describe('parseStreamMessage', () => {
  it('returns a well-formed message', () => {
    expect(parseStreamMessage(JSON.stringify(received))).toEqual(received);
  });

  it.each([
    'not json',
    'null',
    '"a string"',
    '[]',
    '{"type":"unknown.type","at":"x","data":{}}',
    '{"type":"event.received","data":{}}',
    '{"type":"event.received","at":"x"}',
    '{"type":"event.received","at":"x","data":null}',
    '{"type":7,"at":"x","data":{}}',
  ])('returns null for %s', (raw) => {
    expect(parseStreamMessage(raw)).toBeNull();
  });
});

describe('createStreamSubscriber', () => {
  it('subscribes to hdl:stream:{tenantId} on the first listener and delivers messages', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);
    const seen: StreamMessage[] = [];

    await subscriber.subscribe('tenant-a', (message) => seen.push(message));
    fake.emitMessage('tenant-a', received);

    expect(fake.subscribeCalls).toEqual(['hdl:stream:tenant-a']);
    expect(seen).toEqual([received]);
  });

  it('sends one SUBSCRIBE for several listeners of a tenant and one UNSUBSCRIBE after the last', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);
    const first: StreamMessage[] = [];
    const second: StreamMessage[] = [];

    const stopFirst = await subscriber.subscribe('tenant-a', (m) => first.push(m));
    const stopSecond = await subscriber.subscribe('tenant-a', (m) => second.push(m));
    expect(subscriber.listenerCount('tenant-a')).toBe(2);
    expect(fake.subscribeCalls).toHaveLength(1);

    fake.emitMessage('tenant-a', received);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    await stopFirst();
    expect(fake.unsubscribeCalls).toEqual([]); // one listener is still there
    fake.emitMessage('tenant-a', received);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);

    await stopSecond();
    expect(fake.unsubscribeCalls).toEqual(['hdl:stream:tenant-a']);
    expect(subscriber.listenerCount('tenant-a')).toBe(0);

    // Stopping twice is harmless.
    await stopSecond();
    expect(fake.unsubscribeCalls).toHaveLength(1);
  });

  it('subscribes again when a tenant gets a listener after its last one left', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);

    const stop = await subscriber.subscribe('tenant-a', () => {});
    await stop();
    await subscriber.subscribe('tenant-a', () => {});

    expect(fake.subscribeCalls).toEqual(['hdl:stream:tenant-a', 'hdl:stream:tenant-a']);
  });

  it('SEC-AUTH-05 never hands a listener a message from another tenant’s channel', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);
    const tenantA: StreamMessage[] = [];
    const tenantB: StreamMessage[] = [];
    await subscriber.subscribe('tenant-a', (m) => tenantA.push(m));
    await subscriber.subscribe('tenant-b', (m) => tenantB.push(m));

    fake.emitMessage('tenant-b', received);
    fake.emitMessage('tenant-c', received); // nobody listens: dropped

    expect(tenantA).toEqual([]);
    expect(tenantB).toEqual([received]);
  });

  it('ignores a malformed message and keeps delivering the next one', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);
    const seen: StreamMessage[] = [];
    await subscriber.subscribe('tenant-a', (m) => seen.push(m));

    fake.emitMessage('tenant-a', 'not json');
    fake.emitMessage('tenant-a', received);

    expect(seen).toEqual([received]);
  });

  it('keeps delivering to other listeners when one throws', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);
    const seen: StreamMessage[] = [];
    await subscriber.subscribe('tenant-a', () => {
      throw new Error('closed response');
    });
    await subscriber.subscribe('tenant-a', (m) => seen.push(m));

    fake.emitMessage('tenant-a', received);

    expect(seen).toEqual([received]);
  });

  it('registers nothing when Redis refuses the SUBSCRIBE, also for a listener that joined meanwhile', async () => {
    const fake = fakeRedis({ failSubscribe: true });
    const subscriber = createStreamSubscriber(fake.redis, logger);

    const results = await Promise.allSettled([
      subscriber.subscribe('tenant-a', () => {}),
      subscriber.subscribe('tenant-a', () => {}),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(subscriber.listenerCount('tenant-a')).toBe(0);
    expect(fake.subscribeCalls).toHaveLength(1);
  });

  it('close() unsubscribes every channel and stops listening to the connection', async () => {
    const fake = fakeRedis();
    const subscriber = createStreamSubscriber(fake.redis, logger);
    const seen: StreamMessage[] = [];
    await subscriber.subscribe('tenant-a', (m) => seen.push(m));
    await subscriber.subscribe('tenant-b', (m) => seen.push(m));

    await subscriber.close();
    fake.emitMessage('tenant-a', received);

    expect(fake.unsubscribeCalls.sort()).toEqual(['hdl:stream:tenant-a', 'hdl:stream:tenant-b']);
    expect(fake.messageListenerCount()).toBe(0);
    expect(seen).toEqual([]);

    // Closing with nothing subscribed sends no command.
    const idle = fakeRedis();
    await createStreamSubscriber(idle.redis, logger).close();
    expect(idle.unsubscribeCalls).toEqual([]);
  });
});
