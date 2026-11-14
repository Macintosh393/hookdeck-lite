// Integration test for the live stream's two halves, publisher and subscriber, over the real
// Redis pub/sub. Tenant ids are random, so parallel test files never share a channel.
import { randomUUID } from 'node:crypto';
import type { StreamMessage } from '@hdl/shared';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiSubscriberConnection, createWorkerProducerConnection } from '../src/redis.js';
import { publishStreamMessage } from '../src/stream/publisher.js';
import { createStreamSubscriber } from '../src/stream/subscriber.js';
import type { StreamSubscriber } from '../src/stream/subscriber.js';
import { captureLogger, redisUrl } from './helpers.js';

const messageFor = (eventId: string): StreamMessage => ({
  type: 'event.received',
  at: new Date().toISOString(),
  data: { eventId, sourceId: 'src-1' },
});

async function eventually(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('stream publisher and subscriber over Redis pub/sub', () => {
  const { logger } = captureLogger();
  let publisher: Redis;
  let subscriberConnection: Redis;
  let subscriber: StreamSubscriber;

  beforeAll(() => {
    publisher = createWorkerProducerConnection(redisUrl, logger);
    // A dedicated connection: after SUBSCRIBE it can run no other command.
    subscriberConnection = createApiSubscriberConnection(redisUrl, logger);
    subscriber = createStreamSubscriber(subscriberConnection, logger);
  });

  afterAll(async () => {
    await subscriber.close();
    subscriberConnection.disconnect();
    publisher.disconnect();
  });

  it('delivers a published message to the tenant’s listener', async () => {
    const tenantId = randomUUID();
    const seen: StreamMessage[] = [];
    const stop = await subscriber.subscribe(tenantId, (message) => seen.push(message));

    const message = messageFor('evt-1');
    expect(await publishStreamMessage(publisher, logger, tenantId, message)).toBe(true);
    await eventually(() => seen.length === 1);

    expect(seen).toEqual([message]);
    await stop();
  });

  it('SEC-AUTH-05 a subscription for tenant A never receives tenant B’s messages', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const seenByA: StreamMessage[] = [];
    const seenByB: StreamMessage[] = [];
    const stopA = await subscriber.subscribe(tenantA, (message) => seenByA.push(message));
    const stopB = await subscriber.subscribe(tenantB, (message) => seenByB.push(message));

    await publishStreamMessage(publisher, logger, tenantB, messageFor('for-b-1'));
    await publishStreamMessage(publisher, logger, tenantB, messageFor('for-b-2'));
    // The marker for A is published last. Pub/sub keeps the order on one connection, so once
    // A has its marker, anything B's messages could have leaked into A would already be there.
    await publishStreamMessage(publisher, logger, tenantA, messageFor('for-a'));
    await eventually(() => seenByA.length >= 1 && seenByB.length >= 2);

    expect(seenByA.map((m) => (m.type === 'event.received' ? m.data.eventId : ''))).toEqual([
      'for-a',
    ]);
    expect(seenByB.map((m) => (m.type === 'event.received' ? m.data.eventId : ''))).toEqual([
      'for-b-1',
      'for-b-2',
    ]);
    await stopA();
    await stopB();
  });

  it('stops delivering after the listener is removed, and Redis has no subscriber left', async () => {
    const tenantId = randomUUID();
    const seen: StreamMessage[] = [];
    const stop = await subscriber.subscribe(tenantId, (message) => seen.push(message));
    await stop();

    // PUBLISH returns the number of connections that received the message.
    const receivers = await publisher.publish(
      `hdl:stream:${tenantId}`,
      JSON.stringify(messageFor('x')),
    );

    expect(receivers).toBe(0);
    expect(seen).toEqual([]);
  });
});
