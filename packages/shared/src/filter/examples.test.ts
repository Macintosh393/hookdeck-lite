// The fourteen worked examples of docs/FILTER-RULES.md#examples, as tests (AC6.1).
// Each example lists events that must match and events that must not. Every filter also goes
// through parseFilter first, so the examples prove validation and evaluation agree.
import { describe, expect, it } from 'vitest';
import { evaluateFilter } from './evaluate.js';
import { parseFilter } from './schema.js';
import type { FilterInput } from './types.js';

/** An event for a test. Parts that are left out default to "empty". */
type Sample = Partial<FilterInput>;

interface Example {
  name: string;
  filter: unknown;
  matches: Sample[];
  doesNotMatch: Sample[];
}

const examples: Example[] = [
  {
    name: '1. Shorthand equality',
    filter: { body: { type: 'order.created' } },
    matches: [{ body: { type: 'order.created', id: 1 } }],
    doesNotMatch: [{ body: { type: 'order.updated' } }],
  },
  {
    name: '2. Nested path with a numeric range',
    filter: { body: { 'data.amount': { $gte: 100, $lt: 1000 } } },
    matches: [{ body: { data: { amount: 250 } } }],
    doesNotMatch: [
      { body: { data: { amount: 1000 } } },
      { body: { data: { amount: '250' } } }, // a string is not a number
    ],
  },
  {
    name: '3. One of several values',
    filter: { body: { type: { $in: ['invoice.paid', 'invoice.payment_failed'] } } },
    matches: [{ body: { type: 'invoice.paid' } }],
    doesNotMatch: [{ body: { type: 'invoice.created' } }],
  },
  {
    name: '4. Excluding values, and what missing means',
    filter: { body: { 'data.status': { $nin: ['draft', 'test'] } } },
    matches: [
      { body: { data: { status: 'live' } } },
      { body: { data: {} } }, // missing satisfies $nin
    ],
    doesNotMatch: [{ body: { data: { status: 'draft' } } }],
  },
  {
    name: '5. Presence',
    filter: { body: { 'data.customer.email': { $exists: true } } },
    matches: [{ body: { data: { customer: { email: null } } } }], // present, value null
    doesNotMatch: [{ body: { data: { customer: {} } } }],
  },
  {
    name: '6. Header match',
    filter: { headers: { 'x-github-event': 'push' } },
    matches: [{ headers: { 'x-github-event': 'push' } }],
    doesNotMatch: [{ headers: { 'x-github-event': 'pull_request' } }],
  },
  {
    name: '7. Prefix on a string',
    filter: { body: { ref: { $startsWith: 'refs/heads/release/' } } },
    matches: [{ body: { ref: 'refs/heads/release/1.4' } }],
    doesNotMatch: [{ body: { ref: 'refs/heads/main' } }],
  },
  {
    name: '8. Contains, on a string and on an array',
    filter: { body: { message: { $contains: 'urgent' }, labels: { $contains: 'billing' } } },
    matches: [{ body: { message: 'urgent: card declined', labels: ['billing', 'eu'] } }],
    doesNotMatch: [{ body: { message: 'urgent: card declined', labels: ['shipping'] } }],
  },
  {
    name: '9. OR inside a section',
    filter: { body: { $or: [{ 'data.country': 'DE' }, { 'data.currency': 'EUR' }] } },
    matches: [{ body: { data: { country: 'FR', currency: 'EUR' } } }],
    doesNotMatch: [{ body: { data: { country: 'US', currency: 'USD' } } }],
  },
  {
    name: '10. NOT at condition level',
    filter: { body: { 'data.email': { $not: { $contains: '@example.com' } } } },
    matches: [
      { body: { data: { email: 'ana@acme.io' } } },
      { body: { data: {} } }, // the nested $contains is false, so $not is true
    ],
    doesNotMatch: [{ body: { data: { email: 'test@example.com' } } }],
  },
  {
    name: '11. Top-level OR across sections',
    filter: {
      $or: [{ headers: { 'x-priority': 'high' } }, { body: { 'data.amount': { $gt: 10000 } } }],
    },
    matches: [{ headers: {}, body: { data: { amount: 25000 } } }],
    doesNotMatch: [{ headers: { 'x-priority': 'low' }, body: { data: { amount: 50 } } }],
  },
  {
    name: '12. Query parameter and array index',
    filter: { query: { env: 'prod' }, body: { 'items.0.sku': { $startsWith: 'SUB-' } } },
    matches: [{ query: { env: 'prod' }, body: { items: [{ sku: 'SUB-123' }] } }],
    doesNotMatch: [{ query: { env: 'prod' }, body: { items: [] } }], // index 0 is missing
  },
  {
    name: '13. ISO timestamp comparison',
    filter: { body: { created_at: { $gte: '2026-01-01T00:00:00Z' } } },
    matches: [{ body: { created_at: '2026-03-10T08:00:00Z' } }],
    doesNotMatch: [{ body: { created_at: '2025-12-31T23:59:59Z' } }],
  },
  {
    name: '14. Combining everything',
    filter: {
      body: {
        type: { $in: ['order.created', 'order.updated'] },
        $not: { 'data.test': true },
        $and: [
          { 'data.total': { $gt: 0 } },
          { $or: [{ 'data.channel': 'web' }, { 'data.channel': { $exists: false } }] },
        ],
      },
      headers: { 'x-environment': { $neq: 'staging' } },
    },
    matches: [{ headers: {}, body: { type: 'order.created', data: { total: 40 } } }],
    doesNotMatch: [
      { headers: {}, body: { type: 'order.created', data: { total: 40, test: true } } },
    ],
  },
];

function toInput(sample: Sample): FilterInput {
  return { body: sample.body, headers: sample.headers ?? {}, query: sample.query ?? {} };
}

describe('FILTER-RULES.md examples (AC6.1)', () => {
  for (const example of examples) {
    describe(example.name, () => {
      const parsed = parseFilter(example.filter);

      it('is accepted by parseFilter', () => {
        expect(parsed).toMatchObject({ ok: true });
      });

      it.each(example.matches)('matches %j', (sample) => {
        if (!parsed.ok) throw new Error('filter did not parse');
        expect(evaluateFilter(parsed.filter, toInput(sample))).toBe(true);
      });

      it.each(example.doesNotMatch)('does not match %j', (sample) => {
        if (!parsed.ok) throw new Error('filter did not parse');
        expect(evaluateFilter(parsed.filter, toInput(sample))).toBe(false);
      });
    });
  }
});
