// Evaluation of the filter DSL: a pure function from (filter, event) to match / no match.
// The worker's fan-out and the dashboard's filter tester both call it, so a preview can never
// disagree with what is delivered. Pipeline position: fan-out.
// Spec: docs/FILTER-RULES.md#evaluation-semantics
import type {
  Condition,
  ConditionObject,
  Filter,
  FilterInput,
  FilterPrimitive,
  Section,
} from './types.js';

/** The result of following a path: the value, or the fact that the path does not exist. */
type Resolved = { found: true; value: unknown } | { found: false };

const MISSING: Resolved = { found: false };

/** "0", "7", "42": a non-negative integer with no leading zeros, usable as an array index. */
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/**
 * Follows a dot path such as "items.0.sku" from `root`.
 *
 * Only own properties are read (Object.hasOwn), never inherited ones, so a path cannot reach
 * `toString`, `constructor`, or anything else on the prototype chain.
 * A property whose value is null is found, with value null. Missing and null are different.
 */
function resolvePath(root: unknown, path: string): Resolved {
  let current = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return MISSING;
      const index = Number(segment);
      if (index >= current.length) return MISSING;
      current = current[index] as unknown;
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.hasOwn(current, segment)) return MISSING;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return MISSING; // a string, number, boolean, null or undefined has nothing below it
    }
  }
  return { found: true, value: current };
}

/** Strict equality with no type coercion: "5" is not 5, and null equals only null. */
function equalsPrimitive(resolved: Resolved, operand: FilterPrimitive): boolean {
  return resolved.found && resolved.value === operand;
}

/**
 * Ordering comparison. Both sides must be numbers, or both strings; any other pairing is false.
 * Strings compare by UTF-16 code units, which orders ISO-8601 timestamps of one format correctly.
 * `holds` receives a negative, zero or positive number, like the result of a sort comparator.
 * A NaN on either side makes the difference NaN, and every comparison with NaN is false.
 */
function compareOrder(
  resolved: Resolved,
  operand: number | string,
  holds: (difference: number) => boolean,
): boolean {
  if (!resolved.found) return false;
  const value = resolved.value;
  if (typeof value === 'number' && typeof operand === 'number') {
    return holds(value - operand);
  }
  if (typeof value === 'string' && typeof operand === 'string') {
    return holds(value < operand ? -1 : value > operand ? 1 : 0);
  }
  return false;
}

function contains(resolved: Resolved, operand: FilterPrimitive): boolean {
  if (!resolved.found) return false;
  const value = resolved.value;
  if (typeof value === 'string') return typeof operand === 'string' && value.includes(operand);
  if (Array.isArray(value)) return value.some((item) => item === operand);
  return false;
}

/** Applies one operator. An operator this code does not know never matches (fail closed). */
function matchOperator(operator: string, operand: unknown, resolved: Resolved): boolean {
  switch (operator) {
    case '$eq':
      return equalsPrimitive(resolved, operand as FilterPrimitive);
    case '$neq':
      return !equalsPrimitive(resolved, operand as FilterPrimitive);
    case '$in':
      return (operand as FilterPrimitive[]).some((item) => equalsPrimitive(resolved, item));
    case '$nin':
      return !(operand as FilterPrimitive[]).some((item) => equalsPrimitive(resolved, item));
    case '$exists':
      return resolved.found === operand;
    case '$gt':
      return compareOrder(resolved, operand as number | string, (d) => d > 0);
    case '$gte':
      return compareOrder(resolved, operand as number | string, (d) => d >= 0);
    case '$lt':
      return compareOrder(resolved, operand as number | string, (d) => d < 0);
    case '$lte':
      return compareOrder(resolved, operand as number | string, (d) => d <= 0);
    case '$contains':
      return contains(resolved, operand as FilterPrimitive);
    case '$startsWith':
      return (
        resolved.found &&
        typeof resolved.value === 'string' &&
        typeof operand === 'string' &&
        resolved.value.startsWith(operand)
      );
    case '$not':
      return !matchConditionObject(operand as ConditionObject, resolved);
    default:
      return false;
  }
}

/** Several operators on one path are ANDed. */
function matchConditionObject(condition: ConditionObject, resolved: Resolved): boolean {
  return Object.entries(condition).every(([operator, operand]) =>
    matchOperator(operator, operand, resolved),
  );
}

function matchCondition(condition: Condition, resolved: Resolved): boolean {
  // A bare primitive is shorthand for { $eq: primitive }.
  if (typeof condition !== 'object' || condition === null) {
    return equalsPrimitive(resolved, condition);
  }
  return matchConditionObject(condition, resolved);
}

/** Every key of a section must hold: paths, and $and / $or / $not when they appear beside paths. */
function matchSection(section: Section, root: unknown): boolean {
  return Object.entries(section).every(([key, value]) => {
    if (key === '$and') return (value as Section[]).every((item) => matchSection(item, root));
    if (key === '$or') return (value as Section[]).some((item) => matchSection(item, root));
    if (key === '$not') return !matchSection(value as Section, root);
    return matchCondition(value as Condition, resolvePath(root, key));
  });
}

function matchFilter(filter: Filter, input: FilterInput): boolean {
  return Object.entries(filter).every(([key, value]) => {
    switch (key) {
      case 'body':
        return matchSection(value as Section, input.body);
      case 'headers':
        return matchSection(value as Section, input.headers);
      case 'query':
        return matchSection(value as Section, input.query);
      case '$and':
        return (value as Filter[]).every((item) => matchFilter(item, input));
      case '$or':
        return (value as Filter[]).some((item) => matchFilter(item, input));
      case '$not':
        return !matchFilter(value as Filter, input);
      default:
        return false; // an unknown section never matches (fail closed)
    }
  });
}

/**
 * Decides whether an event passes a filter. A null filter matches everything.
 *
 * It never throws, does no I/O, and has no side effects. If the filter is malformed in a way
 * `parseFilter` would have rejected, the answer is `false`: failing closed avoids delivering
 * events to a destination that asked not to receive them (AC6.3).
 */
export function evaluateFilter(filter: Filter | null, input: FilterInput): boolean {
  if (filter === null) return true;
  try {
    return matchFilter(filter, input);
  } catch {
    return false;
  }
}
