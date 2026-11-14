// Unit tests for the signed request of a delivery attempt: the header set of
// docs/SECURITY.md#outbound-signing and what is stored of it.
import { generateWhsecSecret, REDACTED } from '@hdl/core';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import {
  buildOutboundHeaders,
  OUTBOUND_USER_AGENT,
  redactOutboundHeaders,
} from './outbound-request.js';

const input = {
  eventId: '0197a3c2-7b1e-7c3a-9a55-3f2b1c0d9e8f',
  body: '{"type":"order.created","data":{"id":"ord_123"}}',
  contentType: 'application/json',
  deliveryId: '0197a3c2-9d00-7000-8000-000000000001',
  attemptNumber: 3,
  signingSecret: generateWhsecSecret(),
  timestampSeconds: Math.floor(Date.now() / 1000),
};

describe('buildOutboundHeaders', () => {
  it('AC8.1 sets webhook-id to the event id and webhook-timestamp to the send time in seconds', () => {
    const headers = buildOutboundHeaders(input);

    expect(headers['webhook-id']).toBe(input.eventId);
    expect(headers['webhook-timestamp']).toBe(String(input.timestampSeconds));
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
  });

  it('SEC-OUT-01 the official standardwebhooks package verifies the headers we build', () => {
    const headers = buildOutboundHeaders(input);

    // Throws if the signature, the id or the timestamp does not match the body.
    expect(new Webhook(input.signingSecret).verify(input.body, headers)).toEqual(
      JSON.parse(input.body),
    );
    expect(() => new Webhook(input.signingSecret).verify(`${input.body} `, headers)).toThrow();
    expect(() => new Webhook(generateWhsecSecret()).verify(input.body, headers)).toThrow();
  });

  it('carries the content type of the event, our user agent, and the delivery and attempt ids', () => {
    const headers = buildOutboundHeaders({
      ...input,
      contentType: 'application/json; charset=utf-8',
    });

    expect(headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'user-agent': OUTBOUND_USER_AGENT,
      'x-hdl-delivery-id': input.deliveryId,
      'x-hdl-attempt': '3',
    });
    expect(Object.keys(headers)).toHaveLength(7);
  });

  it('SEC-OUT-02 a later attempt keeps the webhook-id and gets a new timestamp and signature', () => {
    const first = buildOutboundHeaders(input);
    const second = buildOutboundHeaders({
      ...input,
      attemptNumber: 4,
      timestampSeconds: input.timestampSeconds + 60,
    });

    expect(second['webhook-id']).toBe(first['webhook-id']);
    expect(second['webhook-timestamp']).not.toBe(first['webhook-timestamp']);
    expect(second['webhook-signature']).not.toBe(first['webhook-signature']);
  });
});

describe('redactOutboundHeaders', () => {
  it('replaces the signature and keeps every other header for the attempts timeline', () => {
    const headers = buildOutboundHeaders(input);

    const stored = redactOutboundHeaders(headers);

    expect(stored['webhook-signature']).toBe(REDACTED);
    expect({ ...stored, 'webhook-signature': headers['webhook-signature'] }).toEqual(headers);
    // The headers that are sent are not changed by storing them.
    expect(headers['webhook-signature']).not.toBe(REDACTED);
  });
});
