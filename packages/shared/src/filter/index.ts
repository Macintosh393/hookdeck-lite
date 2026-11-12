// Public surface of the filter engine. Spec: docs/FILTER-RULES.md
export { evaluateFilter } from './evaluate.js';
export { FILTER_LIMITS, parseFilter } from './schema.js';
export type {
  Condition,
  ConditionObject,
  Filter,
  FilterInput,
  FilterIssue,
  FilterPrimitive,
  ParseFilterResult,
  Section,
} from './types.js';
