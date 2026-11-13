// Validation of the filter DSL: `parseFilter` turns untrusted JSON into a typed Filter or a list
// of issues. It runs when a connection is created or updated, and again before evaluation.
// Pipeline position: fan-out. Spec: docs/FILTER-RULES.md#grammar and #limits
import { z } from 'zod';
import type {
  Condition,
  ConditionObject,
  Filter,
  FilterIssue,
  ParseFilterResult,
  Section,
} from './types.js';

/** Every limit of docs/FILTER-RULES.md#limits in one place. */
export const FILTER_LIMITS = {
  maxSerializedBytes: 4096,
  /** Nesting depth of $and / $or / $not. */
  maxDepth: 5,
  /** Total operator applications in one filter. */
  maxConditions: 50,
  /** Items in one $and / $or. */
  maxLogicItems: 10,
  /** Items in one $in / $nin. */
  maxListItems: 50,
  maxPathLength: 256,
  maxPathSegments: 10,
  maxStringOperandLength: 1024,
} as const;

/**
 * Path segments that would reach into JavaScript's object machinery instead of the event's data.
 * Rejecting them is prototype-pollution hygiene (threat T16 in docs/SECURITY.md).
 */
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const SECTION_LOGIC_KEYS: ReadonlySet<string> = new Set(['$and', '$or', '$not']);

// ---------------------------------------------------------------------------------------------
// Zod schemas: the shape of the DSL
// ---------------------------------------------------------------------------------------------

const stringOperandSchema = z.string().max(FILTER_LIMITS.maxStringOperandLength);
const primitiveSchema = z.union([stringOperandSchema, z.number(), z.boolean(), z.null()]);
const orderableSchema = z.union([z.number(), stringOperandSchema]);
const primitiveListSchema = z.array(primitiveSchema).min(1).max(FILTER_LIMITS.maxListItems);

// z.strictObject rejects keys it does not know, so "$regex" fails with "Unrecognized key".
// z.lazy is needed because $not contains another condition object (a recursive type).
const conditionObjectSchema: z.ZodType<ConditionObject> = z.lazy(() =>
  z
    .strictObject({
      $eq: primitiveSchema.optional(),
      $neq: primitiveSchema.optional(),
      $in: primitiveListSchema.optional(),
      $nin: primitiveListSchema.optional(),
      $exists: z.boolean().optional(),
      $gt: orderableSchema.optional(),
      $gte: orderableSchema.optional(),
      $lt: orderableSchema.optional(),
      $lte: orderableSchema.optional(),
      $contains: primitiveSchema.optional(),
      $startsWith: stringOperandSchema.optional(),
      $not: conditionObjectSchema.optional(),
    })
    .refine((condition) => Object.keys(condition).length > 0, {
      message: 'a condition object needs at least one operator',
    }),
);

const conditionSchema: z.ZodType<Condition> = z.union([primitiveSchema, conditionObjectSchema]);

/** Returns the reason a section key is not a usable path, or null when it is fine. */
function describePathProblem(path: string): string | null {
  if (path.startsWith('$')) return `unknown operator "${path}"`;
  if (path.length > FILTER_LIMITS.maxPathLength) {
    return `path is longer than ${FILTER_LIMITS.maxPathLength} characters`;
  }
  const segments = path.split('.');
  if (segments.length > FILTER_LIMITS.maxPathSegments) {
    return `path has more than ${FILTER_LIMITS.maxPathSegments} segments`;
  }
  if (segments.some((segment) => segment === '')) return 'path has an empty segment';
  return null;
}

// A section mixes two kinds of keys: the three logic keys, which have fixed shapes, and any
// number of path keys, whose values are conditions. `catchall` validates every key that is not
// declared explicitly, and the refinement then checks that those keys are legal paths.
const sectionSchema: z.ZodType<Section> = z.lazy(() =>
  z
    .object({
      $and: z.array(sectionSchema).min(1).max(FILTER_LIMITS.maxLogicItems).optional(),
      $or: z.array(sectionSchema).min(1).max(FILTER_LIMITS.maxLogicItems).optional(),
      $not: sectionSchema.optional(),
    })
    .catchall(conditionSchema)
    .superRefine((section, context) => {
      for (const key of Object.keys(section)) {
        if (SECTION_LOGIC_KEYS.has(key)) continue;
        const problem = describePathProblem(key);
        if (problem) context.addIssue({ code: 'custom', message: problem, path: [key] });
      }
    }),
);

const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.strictObject({
    body: sectionSchema.optional(),
    headers: sectionSchema.optional(),
    query: sectionSchema.optional(),
    $and: z.array(filterSchema).min(1).max(FILTER_LIMITS.maxLogicItems).optional(),
    $or: z.array(filterSchema).min(1).max(FILTER_LIMITS.maxLogicItems).optional(),
    $not: filterSchema.optional(),
  }),
);

// ---------------------------------------------------------------------------------------------
// Checks that look at the filter as a whole
// ---------------------------------------------------------------------------------------------

/**
 * Finds keys with a forbidden path segment anywhere in the raw input.
 *
 * This runs on the raw value, before Zod, for a reason: Zod builds a new object while parsing,
 * and a key named "__proto__" is silently dropped on the way. A filter `{"body":{"__proto__":1}}`
 * would then validate as the empty section `{}`, which matches every event.
 */
function findForbiddenKeys(value: unknown, path: string[], issues: FilterIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, [...path, String(index)], issues));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    const forbidden = key.split('.').find((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
    if (forbidden !== undefined) {
      issues.push({
        path: [...path, key].join('.'),
        message: `forbidden path segment "${forbidden}"`,
      });
    }
    findForbiddenKeys(child, [...path, key], issues);
  }
}

/** Running totals for the two limits that span the whole filter. */
interface FilterSize {
  /** Deepest nesting of $and / $or / $not seen so far. */
  depth: number;
  /** Operator applications counted so far. */
  conditions: number;
}

function measureCondition(condition: Condition, depth: number, size: FilterSize): void {
  size.depth = Math.max(size.depth, depth);
  if (typeof condition !== 'object' || condition === null) {
    size.conditions += 1; // shorthand equality is one $eq
    return;
  }
  size.conditions += Object.keys(condition).length;
  if (condition.$not !== undefined) measureCondition(condition.$not, depth + 1, size);
}

function measureSection(section: Section, depth: number, size: FilterSize): void {
  size.depth = Math.max(size.depth, depth);
  for (const [key, value] of Object.entries(section)) {
    if (key === '$and' || key === '$or') {
      for (const item of value as Section[]) measureSection(item, depth + 1, size);
    } else if (key === '$not') {
      measureSection(value as Section, depth + 1, size);
    } else {
      measureCondition(value as Condition, depth, size);
    }
  }
}

function measureFilter(filter: Filter, depth: number, size: FilterSize): void {
  size.depth = Math.max(size.depth, depth);
  for (const section of [filter.body, filter.headers, filter.query]) {
    if (section !== undefined) measureSection(section, depth, size);
  }
  for (const item of [...(filter.$and ?? []), ...(filter.$or ?? [])]) {
    measureFilter(item, depth + 1, size);
  }
  if (filter.$not !== undefined) measureFilter(filter.$not, depth + 1, size);
}

/** Size of the filter as JSON text in UTF-8 bytes, or null when it cannot be serialized. */
function serializedByteLength(input: unknown): number | null {
  try {
    const json: unknown = JSON.stringify(input);
    return typeof json === 'string' ? new TextEncoder().encode(json).length : null;
  } catch {
    return null; // for example a circular structure
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Validates an untrusted value as a filter. Never throws.
 *
 * The checks run cheapest first and stop at the first stage that finds a problem:
 * serialized size, forbidden path segments, the shape (Zod), then depth and condition count.
 */
export function parseFilter(input: unknown): ParseFilterResult {
  const bytes = serializedByteLength(input);
  if (bytes === null) {
    return { ok: false, issues: [{ path: '', message: 'filter must be a JSON object' }] };
  }
  if (bytes > FILTER_LIMITS.maxSerializedBytes) {
    return {
      ok: false,
      issues: [
        { path: '', message: `filter is larger than ${FILTER_LIMITS.maxSerializedBytes} bytes` },
      ],
    };
  }

  const forbidden: FilterIssue[] = [];
  findForbiddenKeys(input, [], forbidden);
  if (forbidden.length > 0) return { ok: false, issues: forbidden };

  const parsed = filterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const size: FilterSize = { depth: 0, conditions: 0 };
  measureFilter(parsed.data, 0, size);
  const issues: FilterIssue[] = [];
  if (size.depth > FILTER_LIMITS.maxDepth) {
    issues.push({
      path: '',
      message: `$and / $or / $not are nested deeper than ${FILTER_LIMITS.maxDepth} levels`,
    });
  }
  if (size.conditions > FILTER_LIMITS.maxConditions) {
    issues.push({
      path: '',
      message: `filter has more than ${FILTER_LIMITS.maxConditions} conditions`,
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, filter: parsed.data };
}
