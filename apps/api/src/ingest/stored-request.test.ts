// Unit tests for the helpers that shape what an Event row stores (docs/SECURITY.md#input-limits).
import { describe, expect, it } from 'vitest';
import {
  isJsonContentType,
  readExternalEventId,
  sensitiveHeaderNames,
  toStoredHeaders,
  toStoredQuery,
} from './stored-request.js';

const standard = sensitiveHeaderNames({ mode: 'standard-webhooks' });

describe('toStoredHeaders', () => {
  it('lowercases names and keeps ordinary values', () => {
    expect(
      toStoredHeaders({ 'Content-Type': 'application/json', 'X-Trace': 'abc' }, standard),
    ).toEqual({
      'content-type': 'application/json',
      'x-trace': 'abc',
    });
  });

  it('replaces credentials with [redacted]', () => {
    const stored = toStoredHeaders(
      {
        authorization: 'Bearer token',
        cookie: 'a=b',
        'webhook-signature': 'v1,abc',
        'webhook-id': 'm1',
      },
      standard,
    );

    expect(stored).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      'webhook-signature': '[redacted]',
      'webhook-id': 'm1',
    });
  });

  it("redacts a generic-hmac source's own signature header", () => {
    const names = sensitiveHeaderNames({
      mode: 'generic-hmac',
      signatureHeader: 'x-hub-signature-256',
      signatureEncoding: 'hex',
    });

    expect(toStoredHeaders({ 'x-hub-signature-256': 'sha256=abc' }, names)).toEqual({
      'x-hub-signature-256': '[redacted]',
    });
  });

  it('cuts a value at 8 KiB and joins repeated headers', () => {
    const stored = toStoredHeaders({ 'x-long': 'a'.repeat(9000), 'x-multi': ['1', '2'] }, standard);

    expect(stored['x-long']).toHaveLength(8192);
    expect(stored['x-multi']).toBe('1, 2');
  });

  it('keeps at most 100 headers and skips undefined values', () => {
    const many: Record<string, string | undefined> = { skipped: undefined };
    for (let i = 0; i < 150; i += 1) many[`x-h-${i}`] = String(i);

    const stored = toStoredHeaders(many, standard);

    expect(Object.keys(stored)).toHaveLength(100);
    expect(stored).not.toHaveProperty('skipped');
  });
});

describe('toStoredQuery', () => {
  it('keeps strings and string arrays, and drops everything else', () => {
    expect(toStoredQuery({ a: '1', b: ['x', 'y'], c: { nested: true }, d: 5 })).toEqual({
      a: '1',
      b: ['x', 'y'],
    });
    expect(toStoredQuery(undefined)).toEqual({});
  });

  it('removes NUL characters, which Postgres cannot store', () => {
    expect(toStoredQuery({ a: 'x\u0000y', b: ['\u0000'] })).toEqual({ a: 'xy', b: [''] });
  });
});

describe('readExternalEventId', () => {
  it('reads the configured header', () => {
    expect(readExternalEventId({ 'webhook-id': 'msg_1' }, 'webhook-id')).toBe('msg_1');
    expect(readExternalEventId({ 'x-github-delivery': 'abc' }, 'X-GitHub-Delivery')).toBe('abc');
  });

  it('returns null when no header is configured or the request has none', () => {
    expect(readExternalEventId({ 'webhook-id': 'msg_1' }, null)).toBeNull();
    expect(readExternalEventId({}, 'webhook-id')).toBeNull();
    expect(readExternalEventId({ 'webhook-id': '' }, 'webhook-id')).toBeNull();
  });

  it('cuts the id at 255 characters', () => {
    expect(readExternalEventId({ 'webhook-id': 'x'.repeat(300) }, 'webhook-id')).toHaveLength(255);
  });
});

describe('isJsonContentType', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])(
    'accepts %s',
    (value) => expect(isJsonContentType(value)).toBe(true),
  );

  it.each([undefined, '', 'text/plain', 'application/jsonp', 'application/x-www-form-urlencoded'])(
    'rejects %s',
    (value) => expect(isJsonContentType(value)).toBe(false),
  );
});
