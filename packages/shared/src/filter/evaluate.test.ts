// Unit tests for the evaluation rules of docs/FILTER-RULES.md#evaluation-semantics that the worked
// examples do not pin down one by one: path resolution, the missing-path table, the type rules,
// and combination. Examples themselves are in examples.test.ts.
import { describe, expect, it } from 'vitest';
import { evaluateFilter } from './evaluate.js';
import type { Condition, Filter, FilterInput } from './types.js';

const emptyInput: FilterInput = { body: {}, headers: {}, query: {} };

/** Evaluates one condition on the body path "value". */
function bodyMatches(condition: Condition, body: unknown, path = 'value'): boolean {
  return evaluateFilter({ body: { [path]: condition } }, { ...emptyInput, body });
}

describe('path resolution', () => {
  it('reads nested object properties and array indexes', () => {
    const body = { data: { items: [{ sku: 'A' }, { sku: 'B' }] } };
    expect(bodyMatches('B', body, 'data.items.1.sku')).toBe(true);
    expect(bodyMatches('A', body, 'data.items.1.sku')).toBe(false);
  });

  it('treats an out-of-range index and a non-integer index as missing', () => {
    const body = { items: ['a'] };
    expect(bodyMatches({ $exists: true }, body, 'items.1')).toBe(false);
    expect(bodyMatches({ $exists: true }, body, 'items.length')).toBe(false);
    expect(bodyMatches({ $exists: true }, body, 'items.01')).toBe(false);
    expect(bodyMatches({ $exists: true }, body, 'items.-1')).toBe(false);
  });

  it('does not search inside arrays: "items.sku" is missing, "items.0.sku" is not', () => {
    const body = { items: [{ sku: 'A' }] };
    expect(bodyMatches('A', body, 'items.sku')).toBe(false);
    expect(bodyMatches('A', body, 'items.0.sku')).toBe(true);
  });

  it('treats a step through a primitive or null as missing', () => {
    expect(bodyMatches({ $exists: true }, { a: 'text' }, 'a.b')).toBe(false);
    expect(bodyMatches({ $exists: true }, { a: null }, 'a.b')).toBe(false);
    expect(bodyMatches({ $exists: true }, { a: 5 }, 'a.b')).toBe(false);
  });

  it('distinguishes a property that is null from a property that is missing', () => {
    expect(bodyMatches({ $exists: true }, { value: null })).toBe(true);
    expect(bodyMatches(null, { value: null })).toBe(true);
    expect(bodyMatches(null, {})).toBe(false);
  });

  it('makes every body path missing when the body is not valid JSON (undefined)', () => {
    expect(bodyMatches({ $exists: false }, undefined)).toBe(true);
    expect(bodyMatches('x', undefined)).toBe(false);
  });

  it('never reads inherited properties (SEC-LIM-03)', () => {
    // `toString` and `constructor` exist on every object through the prototype chain.
    // parseFilter rejects "constructor" as a path; evaluation is safe even without that check.
    expect(bodyMatches({ $exists: true }, {}, 'toString')).toBe(false);
    expect(bodyMatches({ $exists: true }, {}, 'constructor')).toBe(false);
    expect(bodyMatches({ $exists: true }, { a: [] }, 'a.constructor')).toBe(false);
  });

  it('reads repeated query keys as arrays and query numbers as strings', () => {
    const input: FilterInput = { body: {}, headers: {}, query: { page: '2', tag: ['a', 'b'] } };
    expect(evaluateFilter({ query: { page: '2' } }, input)).toBe(true);
    expect(evaluateFilter({ query: { page: 2 } }, input)).toBe(false);
    expect(evaluateFilter({ query: { 'tag.1': 'b' } }, input)).toBe(true);
    expect(evaluateFilter({ query: { tag: { $contains: 'a' } } }, input)).toBe(true);
  });
});

describe('missing paths', () => {
  const missing = {}; // the path "value" does not exist

  it.each<[string, Condition]>([
    ['$eq', { $eq: 'x' }],
    ['$in', { $in: ['x'] }],
    ['$gt', { $gt: 1 }],
    ['$gte', { $gte: 1 }],
    ['$lt', { $lt: 1 }],
    ['$lte', { $lte: 1 }],
    ['$contains', { $contains: 'x' }],
    ['$startsWith', { $startsWith: 'x' }],
    ['$exists: true', { $exists: true }],
  ])('%s is false', (_name, condition) => {
    expect(bodyMatches(condition, missing)).toBe(false);
  });

  it.each<[string, Condition]>([
    ['$neq', { $neq: 'x' }],
    ['$nin', { $nin: ['x'] }],
    ['$exists: false', { $exists: false }],
    ['$not of a false condition', { $not: { $eq: 'x' } }],
  ])('%s is true', (_name, condition) => {
    expect(bodyMatches(condition, missing)).toBe(true);
  });

  it('requires presence when $exists: true is added next to $neq', () => {
    expect(bodyMatches({ $neq: 'draft', $exists: true }, {})).toBe(false);
    expect(bodyMatches({ $neq: 'draft', $exists: true }, { value: 'live' })).toBe(true);
  });
});

describe('types', () => {
  it('never coerces: "5" is not 5, true is not "true", null equals only null', () => {
    expect(bodyMatches(5, { value: '5' })).toBe(false);
    expect(bodyMatches('5', { value: 5 })).toBe(false);
    expect(bodyMatches('true', { value: true })).toBe(false);
    expect(bodyMatches(null, { value: 0 })).toBe(false);
    expect(bodyMatches(false, { value: null })).toBe(false);
  });

  it('makes $eq and $in false, and $neq and $nin true, for objects and arrays', () => {
    for (const value of [{ a: 1 }, [1, 2]]) {
      expect(bodyMatches({ $eq: 1 }, { value })).toBe(false);
      expect(bodyMatches({ $in: [1] }, { value })).toBe(false);
      expect(bodyMatches({ $neq: 1 }, { value })).toBe(true);
      expect(bodyMatches({ $nin: [1] }, { value })).toBe(true);
    }
  });

  it('orders numbers numerically', () => {
    expect(bodyMatches({ $gt: 9 }, { value: 10 })).toBe(true);
    expect(bodyMatches({ $gt: 10 }, { value: 10 })).toBe(false);
    expect(bodyMatches({ $gte: 10 }, { value: 10 })).toBe(true);
    expect(bodyMatches({ $lt: 10 }, { value: 9.5 })).toBe(true);
    expect(bodyMatches({ $lte: 10 }, { value: 10 })).toBe(true);
    expect(bodyMatches({ $lte: 10 }, { value: 10.1 })).toBe(false);
  });

  it('orders strings by code unit, case-sensitively', () => {
    expect(bodyMatches({ $gt: 'a' }, { value: 'b' })).toBe(true);
    expect(bodyMatches({ $lt: 'a' }, { value: 'B' })).toBe(true); // "B" (66) sorts before "a" (97)
    expect(bodyMatches({ $gte: 'abc' }, { value: 'abc' })).toBe(true);
    expect(bodyMatches({ $lte: 'abc' }, { value: 'abd' })).toBe(false);
    // As strings, "10" sorts before "9". Numbers in strings are not compared numerically.
    expect(bodyMatches({ $gt: '9' }, { value: '10' })).toBe(false);
  });

  it('makes ordering false for mixed or non-orderable types', () => {
    expect(bodyMatches({ $gt: 1 }, { value: '2' })).toBe(false);
    expect(bodyMatches({ $gt: '1' }, { value: 2 })).toBe(false);
    expect(bodyMatches({ $gte: 0 }, { value: true })).toBe(false);
    expect(bodyMatches({ $lte: 0 }, { value: null })).toBe(false);
    expect(bodyMatches({ $gt: 0 }, { value: [1] })).toBe(false);
    expect(bodyMatches({ $gt: 0 }, { value: { a: 1 } })).toBe(false);
  });

  it('never compares NaN as true', () => {
    for (const condition of [{ $gt: 0 }, { $gte: 0 }, { $lt: 0 }, { $lte: 0 }]) {
      expect(bodyMatches(condition, { value: Number.NaN })).toBe(false);
    }
    expect(bodyMatches(Number.NaN, { value: Number.NaN })).toBe(false);
  });

  it('applies $contains to strings and arrays only', () => {
    expect(bodyMatches({ $contains: 'ell' }, { value: 'hello' })).toBe(true);
    expect(bodyMatches({ $contains: 'ELL' }, { value: 'hello' })).toBe(false); // case-sensitive
    expect(bodyMatches({ $contains: 1 }, { value: 'a1' })).toBe(false); // string needs a string operand
    expect(bodyMatches({ $contains: 2 }, { value: [1, 2] })).toBe(true);
    expect(bodyMatches({ $contains: '2' }, { value: [1, 2] })).toBe(false); // items compare with ===
    expect(bodyMatches({ $contains: null }, { value: [null] })).toBe(true);
    expect(bodyMatches({ $contains: 'a' }, { value: { a: 1 } })).toBe(false);
    expect(bodyMatches({ $contains: 1 }, { value: 1 })).toBe(false);
  });

  it('applies $startsWith to strings only', () => {
    expect(bodyMatches({ $startsWith: 'he' }, { value: 'hello' })).toBe(true);
    expect(bodyMatches({ $startsWith: 'He' }, { value: 'hello' })).toBe(false);
    expect(bodyMatches({ $startsWith: '1' }, { value: 123 })).toBe(false);
  });
});

describe('combination', () => {
  it('matches everything for a null filter, an empty filter, and an empty section', () => {
    expect(evaluateFilter(null, emptyInput)).toBe(true);
    expect(evaluateFilter({}, emptyInput)).toBe(true);
    expect(evaluateFilter({ body: {} }, emptyInput)).toBe(true);
  });

  it('ANDs several operators on one path', () => {
    expect(bodyMatches({ $gte: 1, $lte: 3 }, { value: 2 })).toBe(true);
    expect(bodyMatches({ $gte: 1, $lte: 3 }, { value: 4 })).toBe(false);
  });

  it('ANDs paths with $and, $or and $not at the same level of a section', () => {
    const filter: Filter = {
      body: { a: 1, $or: [{ b: 1 }, { b: 2 }], $not: { c: 1 }, $and: [{ d: { $exists: true } }] },
    };
    const evaluate = (body: unknown) => evaluateFilter(filter, { ...emptyInput, body });
    expect(evaluate({ a: 1, b: 2, d: 0 })).toBe(true);
    expect(evaluate({ a: 2, b: 2, d: 0 })).toBe(false); // path fails
    expect(evaluate({ a: 1, b: 3, d: 0 })).toBe(false); // $or fails
    expect(evaluate({ a: 1, b: 2, c: 1, d: 0 })).toBe(false); // $not fails
    expect(evaluate({ a: 1, b: 2 })).toBe(false); // $and fails
  });

  it('combines sections and top-level $and / $or / $not', () => {
    const input: FilterInput = { body: { type: 'a' }, headers: { 'x-env': 'prod' }, query: {} };
    expect(
      evaluateFilter({ $and: [{ body: { type: 'a' } }, { headers: { 'x-env': 'prod' } }] }, input),
    ).toBe(true);
    expect(
      evaluateFilter({ $and: [{ body: { type: 'a' } }, { headers: { 'x-env': 'dev' } }] }, input),
    ).toBe(false);
    expect(evaluateFilter({ $not: { body: { type: 'a' } } }, input)).toBe(false);
    expect(evaluateFilter({ $not: { body: { type: 'b' } } }, input)).toBe(true);
    expect(evaluateFilter({ body: { type: 'a' }, $or: [{ query: { x: '1' } }] }, input)).toBe(
      false,
    );
  });
});

describe('evaluateFilter never throws (AC6.3)', () => {
  // These filters could only come from a stored value that skipped parseFilter.
  // The answer must be "no match", so nothing is delivered that was not asked for.
  const malformed: unknown[] = [
    { payload: { a: 1 } }, // unknown section
    { body: { a: { $regex: 'x' } } }, // unknown operator
    { body: { a: { $in: 'not-an-array' } } },
    { body: { $and: 'not-an-array' } },
    { $or: { body: {} } },
    { body: null },
    { $not: null },
  ];

  it.each(malformed)('returns false for the malformed filter %j', (filter) => {
    const input: FilterInput = { body: { a: 'x' }, headers: {}, query: {} };
    expect(() => evaluateFilter(filter as Filter, input)).not.toThrow();
    expect(evaluateFilter(filter as Filter, input)).toBe(false);
  });
});
