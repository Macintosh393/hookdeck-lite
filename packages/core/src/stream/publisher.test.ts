// Unit tests for the stream publisher: the channel name and the "never throws" promise.
// Delivery over the real Redis is tested in test/stream.int.test.ts.
import type { StreamMessage } from '@hdl/shared';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { publishStreamMessage, streamChannel } from './publisher.js';

const logger = pino({ level: 'silent' });
const message: StreamMessage = {
  type: 'event.fanned_out',
  at: '2026-11-13T10:00:00.000Z',
  data: { eventId: 'evt-1', deliveryCount: 2, filteredCount: 1 },
};

describe('publishStreamMessage', () => {
  it('uses the canonical channel name hdl:stream:{tenantId}', () => {
    expect(streamChannel('tenant-1')).toBe('hdl:stream:tenant-1');
  });

  it('publishes the message as JSON on the tenant’s channel and returns true', async () => {
    const calls: Array<[string, string]> = [];
    const redis = {
      publish: (channel: string, payload: string) => {
        calls.push([channel, payload]);
        return Promise.resolve(1);
      },
    } as unknown as Redis;

    expect(await publishStreamMessage(redis, logger, 'tenant-1', message)).toBe(true);
    expect(calls).toEqual([['hdl:stream:tenant-1', JSON.stringify(message)]]);
  });

  it('returns false instead of throwing when Redis is down: the stream is best effort', async () => {
    const down = {
      publish: () => Promise.reject(new Error('Connection is closed.')),
    } as unknown as Redis;
    const throwsString = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- on purpose: not every rejection is an Error
      publish: () => Promise.reject('plain string'),
    } as unknown as Redis;

    expect(await publishStreamMessage(down, logger, 'tenant-1', message)).toBe(false);
    expect(await publishStreamMessage(throwsString, logger, 'tenant-1', message)).toBe(false);
  });
});
