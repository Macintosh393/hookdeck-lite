// Unit tests for the pure parts of fan-out: building the filter input from a stored Event and
// deciding whether a connection matches. The processor is tested in test/fanout.int.test.ts.
import { createLogger } from '@hdl/core';
import { describe, expect, it } from 'vitest';
import { buildFilterInput, connectionMatches } from './fanout.processor.js';

const log = createLogger({ level: 'silent', name: 'test' });

const event = {
  body: '{"type":"order.created","data":{"amount":250}}',
  headers: { 'x-environment': 'production' },
  query: { region: 'eu', tag: ['a', 'b'] },
};

describe('buildFilterInput', () => {
  it('parses the body and passes headers and query through', () => {
    expect(buildFilterInput(event)).toEqual({
      body: { type: 'order.created', data: { amount: 250 } },
      headers: { 'x-environment': 'production' },
      query: { region: 'eu', tag: ['a', 'b'] },
    });
  });

  it('treats headers or query that are not objects as empty', () => {
    // The columns are jsonb; anything could have been written into them by hand.
    for (const broken of [null, 'text', 42, ['x']]) {
      const input = buildFilterInput({ body: '{}', headers: broken, query: broken });
      expect(input.headers).toEqual({});
      expect(input.query).toEqual({});
    }
  });

  it('accepts any JSON value as a body, not only objects', () => {
    expect(buildFilterInput({ ...event, body: '[1,2]' }).body).toEqual([1, 2]);
    expect(buildFilterInput({ ...event, body: 'null' }).body).toBeNull();
  });
});

describe('connectionMatches', () => {
  const input = buildFilterInput(event);

  it('AC5.1 a connection without a filter matches every event', () => {
    expect(connectionMatches({ id: 'c1', filter: null }, input, log)).toBe(true);
    expect(connectionMatches({ id: 'c1', filter: undefined }, input, log)).toBe(true);
  });

  it('evaluates the filter against body, headers and query', () => {
    const matches = (filter: unknown) => connectionMatches({ id: 'c1', filter }, input, log);

    expect(matches({ body: { type: 'order.created' } })).toBe(true);
    expect(matches({ body: { type: 'order.refunded' } })).toBe(false);
    expect(matches({ body: { 'data.amount': { $gte: 100 } } })).toBe(true);
    expect(matches({ headers: { 'x-environment': 'production' }, query: { region: 'eu' } })).toBe(
      true,
    );
    expect(matches({ headers: { 'x-environment': 'staging' } })).toBe(false);
  });

  it('AC6.3 a stored filter that does not validate is no match and never throws', () => {
    for (const filter of [{ body: { type: { $regex: '.*' } } }, 'not an object', 42, []]) {
      expect(connectionMatches({ id: 'c1', filter }, input, log)).toBe(false);
    }
  });
});
