// Unit tests for parseFilter: the "Rejected by validation" table and every limit of
// docs/FILTER-RULES.md#limits (AC6.2, SEC-LIM-02, SEC-LIM-03).
import { describe, expect, it } from 'vitest';
import { evaluateFilter } from './evaluate.js';
import { FILTER_LIMITS, parseFilter } from './schema.js';
import type { FilterIssue } from './types.js';

/** Parses a filter that is expected to be rejected, and returns its issues. */
function issuesOf(filter: unknown): FilterIssue[] {
  const result = parseFilter(filter);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues;
}

/** Wraps `inner` in `levels` layers of `{ $not: ... }`. */
function nest(levels: number, inner: unknown, wrap: (value: unknown) => unknown): unknown {
  let value = inner;
  for (let i = 0; i < levels; i += 1) value = wrap(value);
  return value;
}

describe('parseFilter: rejected by validation (AC6.2)', () => {
  it('rejects an unknown operator', () => {
    const issues = issuesOf({ body: { a: { $regex: 'x' } } });
    expect(issues.some((issue) => issue.message.includes('$regex'))).toBe(true);
  });

  it('rejects a forbidden path segment (SEC-LIM-03)', () => {
    // JSON.parse is how a filter arrives from the API. It creates a real own property
    // named "__proto__", which an object literal in source code would not.
    const issues = issuesOf(JSON.parse('{ "body": { "__proto__.polluted": true } }'));
    expect(issues).toEqual([
      { path: 'body.__proto__.polluted', message: 'forbidden path segment "__proto__"' },
    ]);
  });

  it.each([
    '{ "body": { "__proto__": true } }',
    '{ "body": { "a.constructor": 1 } }',
    '{ "body": { "prototype.x": 1 } }',
    '{ "headers": { "a.b.__proto__.c": 1 } }',
    '{ "$or": [ { "body": { "$and": [ { "constructor.name": "x" } ] } } ] }',
  ])('rejects a forbidden segment anywhere: %s (SEC-LIM-03)', (json) => {
    const issues = issuesOf(JSON.parse(json));
    expect(issues[0]?.message).toMatch(/forbidden path segment/);
  });

  it('rejects $in with no items', () => {
    const issues = issuesOf({ body: { a: { $in: [] } } });
    expect(issues[0]?.path).toBe('body.a.$in');
  });

  it('rejects a condition object with no operator', () => {
    const issues = issuesOf({ body: { a: {} } });
    expect(issues.some((issue) => issue.message.includes('at least one operator'))).toBe(true);
  });

  it('rejects an unknown section', () => {
    const issues = issuesOf({ payload: { a: 1 } });
    expect(issues[0]?.message).toContain('payload');
  });

  it('rejects an operand that is not a primitive', () => {
    const issues = issuesOf({ body: { a: { $eq: { x: 1 } } } });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects six nested $not, at every level where $not can appear (SEC-LIM-02)', () => {
    const conditionLevel = { body: { a: nest(6, { $eq: 1 }, (inner) => ({ $not: inner })) } };
    const sectionLevel = { body: nest(6, { a: 1 }, (inner) => ({ $not: inner })) };
    const filterLevel = nest(6, { body: { a: 1 } }, (inner) => ({ $not: inner }));

    for (const filter of [conditionLevel, sectionLevel, filterLevel]) {
      expect(issuesOf(filter)[0]?.message).toMatch(/nested deeper than 5/);
    }
  });

  it('accepts five nested $not', () => {
    const filter = nest(5, { body: { a: 1 } }, (inner) => ({ $not: inner }));
    expect(parseFilter(filter).ok).toBe(true);
  });

  it.each([null, undefined, 'text', 42, [], [{ body: {} }]])(
    'rejects %j, which is not a filter object',
    (value) => {
      expect(parseFilter(value).ok).toBe(false);
    },
  );

  it('rejects a value that cannot be serialized, without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.body = circular;
    expect(issuesOf(circular)[0]?.message).toBe('filter must be a JSON object');
  });
});

describe('parseFilter: limits (SEC-LIM-02)', () => {
  it('rejects a filter larger than 4096 bytes when serialized', () => {
    // Many small conditions, so that only the size limit is exceeded by this input.
    const body: Record<string, string> = {};
    for (let i = 0; i < 45; i += 1) body[`field${i}`] = 'x'.repeat(100);
    expect(issuesOf({ body })[0]?.message).toMatch(/larger than 4096 bytes/);
  });

  it('counts the size in UTF-8 bytes, not characters', () => {
    // 1500 three-byte characters are 4500 bytes but only 1500 characters.
    const filter = { body: { a: 'あ'.repeat(1000), b: 'あ'.repeat(500) } };
    expect(JSON.stringify(filter).length).toBeLessThan(FILTER_LIMITS.maxSerializedBytes);
    expect(issuesOf(filter)[0]?.message).toMatch(/larger than 4096 bytes/);
  });

  it('accepts 50 conditions and rejects 51', () => {
    const withConditions = (count: number) => {
      const body: Record<string, number> = {};
      for (let i = 0; i < count; i += 1) body[`f${i}`] = i;
      return { body };
    };
    expect(parseFilter(withConditions(50)).ok).toBe(true);
    expect(issuesOf(withConditions(51))[0]?.message).toMatch(/more than 50 conditions/);
  });

  it('counts every operator, including those inside $not, as a condition', () => {
    // 17 paths x 3 operator applications ($gte, $not, $eq) = 51.
    const body: Record<string, unknown> = {};
    for (let i = 0; i < 17; i += 1) body[`f${i}`] = { $gte: 1, $not: { $eq: 5 } };
    expect(issuesOf({ body })[0]?.message).toMatch(/more than 50 conditions/);
  });

  it('accepts 10 items in $and / $or and rejects 11', () => {
    const items = (count: number) => Array.from({ length: count }, (_, i) => ({ a: i }));
    expect(parseFilter({ body: { $or: items(10) } }).ok).toBe(true);
    expect(parseFilter({ body: { $and: items(11) } }).ok).toBe(false);
    expect(parseFilter({ $or: Array.from({ length: 11 }, () => ({ body: { a: 1 } })) }).ok).toBe(
      false,
    );
    expect(parseFilter({ $and: [] }).ok).toBe(false);
  });

  it('accepts 50 items in $in / $nin and rejects 51', () => {
    const numbers = (count: number) => Array.from({ length: count }, (_, i) => i);
    expect(parseFilter({ body: { a: { $in: numbers(50) } } }).ok).toBe(true);
    expect(parseFilter({ body: { a: { $nin: numbers(51) } } }).ok).toBe(false);
  });

  it('rejects a path longer than 256 characters', () => {
    const issues = issuesOf({ body: { ['a'.repeat(257)]: 1 } });
    expect(issues[0]?.message).toMatch(/longer than 256 characters/);
  });

  it('accepts a path of 10 segments and rejects 11', () => {
    expect(parseFilter({ body: { 'a.b.c.d.e.f.g.h.i.j': 1 } }).ok).toBe(true);
    expect(issuesOf({ body: { 'a.b.c.d.e.f.g.h.i.j.k': 1 } })[0]?.message).toMatch(
      /more than 10 segments/,
    );
  });

  it('rejects a path with an empty segment', () => {
    expect(issuesOf({ body: { 'a..b': 1 } })[0]?.message).toMatch(/empty segment/);
    expect(issuesOf({ body: { '': 1 } })[0]?.message).toMatch(/empty segment/);
  });

  it('rejects a string operand longer than 1024 characters', () => {
    const long = 'x'.repeat(1025);
    expect(parseFilter({ body: { a: long } }).ok).toBe(false);
    expect(parseFilter({ body: { a: { $startsWith: long } } }).ok).toBe(false);
    expect(parseFilter({ body: { a: { $in: [long] } } }).ok).toBe(false);
    expect(parseFilter({ body: { a: 'x'.repeat(1024) } }).ok).toBe(true);
  });
});

describe('parseFilter: accepted shapes', () => {
  it('accepts the empty filter and empty sections', () => {
    expect(parseFilter({})).toEqual({ ok: true, filter: {} });
    expect(parseFilter({ body: {}, headers: {}, query: {} }).ok).toBe(true);
  });

  it('accepts every operator with a valid operand', () => {
    const filter = {
      body: {
        a: { $eq: null, $neq: 1, $in: ['x', 2, true, null], $nin: [false], $exists: true },
        b: { $gt: 1, $gte: '2026-01-01', $lt: 2.5, $lte: 'z' },
        c: { $contains: 'x', $startsWith: 'y', $not: { $eq: 1 } },
      },
    };
    expect(parseFilter(filter)).toEqual({ ok: true, filter });
  });

  it('rejects operands of the wrong type', () => {
    expect(parseFilter({ body: { a: { $exists: 'yes' } } }).ok).toBe(false);
    expect(parseFilter({ body: { a: { $gt: true } } }).ok).toBe(false);
    expect(parseFilter({ body: { a: { $startsWith: 5 } } }).ok).toBe(false);
    expect(parseFilter({ body: { a: { $in: 'x' } } }).ok).toBe(false);
    expect(parseFilter({ body: { a: [1, 2] } }).ok).toBe(false);
    expect(parseFilter({ body: { $not: [{ a: 1 }] } }).ok).toBe(false);
    expect(parseFilter({ body: 'text' }).ok).toBe(false);
  });

  it('returns a filter that evaluateFilter accepts', () => {
    const result = parseFilter({ body: { 'data.amount': { $gte: 100 } } });
    if (!result.ok) throw new Error('expected the filter to parse');
    const input = { body: { data: { amount: 150 } }, headers: {}, query: {} };
    expect(evaluateFilter(result.filter, input)).toBe(true);
  });
});
