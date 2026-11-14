// Zod schemas for the request bodies and query strings of the management API (/api/v1).
// The api validates with them; the dashboard uses the inferred types for its forms.
// Each schema mirrors one of the same name in docs/api/openapi.yaml. Limits: docs/SECURITY.md#input-limits
import { z } from 'zod';
import { DELIVERY_STATUSES, EVENT_STATUSES, VERIFICATION_MODES } from '../enums.js';
import { parseFilter } from '../filter/schema.js';
import { verificationConfigSchema } from './verification-config.js';

const nameSchema = z.string().trim().min(1).max(100);

/** A header name, stored lowercased. Null switches deduplication off. */
const dedupeHeaderSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a valid HTTP header name')
  .transform((name) => name.toLowerCase())
  .nullable();

/** Scheme check only. The SSRF rules (DNS, IP ranges) run in the api, which can resolve names. */
const destinationUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http or https URL');

/**
 * A filter rule or null. The value is validated by the filter engine's own parser, and its
 * issues are re-reported with their paths, so the API can point at the exact operator (AC6.2).
 */
const filterSchema = z.unknown().superRefine((value, context) => {
  if (value === null || value === undefined) return;
  const result = parseFilter(value);
  if (result.ok) return;
  for (const issue of result.issues) {
    context.addIssue({
      code: 'custom',
      message: issue.message,
      path: issue.path === '' ? [] : issue.path.split('.'),
    });
  }
});

const atLeastOneField = (value: object): boolean => Object.keys(value).length > 0;
const atLeastOneFieldMessage = 'at least one field is required';

// --- Sources ---------------------------------------------------------------------------------

export const sourceCreateSchema = z
  .strictObject({
    name: nameSchema,
    verificationMode: z.enum(VERIFICATION_MODES),
    verificationConfig: verificationConfigSchema.optional(),
    /** Required for generic-hmac, optional for standard-webhooks (generated), forbidden for none. */
    secret: z.string().min(1).max(256).optional(),
    dedupeHeader: dedupeHeaderSchema.optional(),
  })
  .superRefine((source, context) => {
    const { verificationMode: mode, verificationConfig: config, secret } = source;
    if (config !== undefined && config.mode !== mode) {
      context.addIssue({
        code: 'custom',
        message: 'verificationConfig.mode must equal verificationMode',
        path: ['verificationConfig', 'mode'],
      });
    }
    if (mode === 'generic-hmac' && config === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'verificationConfig is required for generic-hmac',
        path: ['verificationConfig'],
      });
    }
    if (mode === 'generic-hmac' && secret === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'secret is required for generic-hmac',
        path: ['secret'],
      });
    }
    if (mode === 'none' && secret !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'secret is not allowed when verificationMode is none',
        path: ['secret'],
      });
    }
  });

export const sourceUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    verificationMode: z.enum(VERIFICATION_MODES).optional(),
    verificationConfig: verificationConfigSchema.optional(),
    secret: z.string().min(1).max(256).optional(),
    dedupeHeader: dedupeHeaderSchema.optional(),
  })
  .refine(atLeastOneField, atLeastOneFieldMessage);

// --- Destinations ----------------------------------------------------------------------------

export const destinationCreateSchema = z.strictObject({
  name: nameSchema,
  url: destinationUrlSchema,
});

export const destinationUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    url: destinationUrlSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(atLeastOneField, atLeastOneFieldMessage);

// --- Connections -----------------------------------------------------------------------------

export const connectionCreateSchema = z.strictObject({
  name: nameSchema,
  sourceId: z.uuid(),
  destinationId: z.uuid(),
  enabled: z.boolean().default(true),
  filter: filterSchema.optional(),
});

export const connectionUpdateSchema = z
  .strictObject({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    filter: filterSchema.optional(),
  })
  .refine(atLeastOneField, atLeastOneFieldMessage);

// --- Lists -----------------------------------------------------------------------------------

/** `?limit=50&cursor=<opaque>`. Query values arrive as strings, hence the coercion. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

/** An ISO-8601 instant with a zone, e.g. `2026-11-12T10:00:00Z`. Kept as a string. */
const instantSchema = z.iso.datetime({ offset: true });

/** `GET /api/v1/events`: the list query plus its filters. */
export const eventListQuerySchema = listQuerySchema.extend({
  sourceId: z.uuid().optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  /** Only events received at or after this time. */
  from: instantSchema.optional(),
  /** Only events received before this time. */
  to: instantSchema.optional(),
});

/** `GET /api/v1/deliveries`: the list query plus its filters. `status=DEAD` is the dead-letter view. */
export const deliveryListQuerySchema = listQuerySchema.extend({
  status: z.enum(DELIVERY_STATUSES).optional(),
  destinationId: z.uuid().optional(),
  connectionId: z.uuid().optional(),
  eventId: z.uuid().optional(),
});

// --- Validation helper -------------------------------------------------------------------------

/** Any of the schemas in this file. Lets the api name the type without depending on zod itself. */
export type InputSchema = z.ZodType;
/** What a schema produces: defaults filled in, query-string numbers coerced. */
export type ParsedInput<Schema extends InputSchema> = z.output<Schema>;

export type InputValidation<T> =
  { ok: true; value: T } | { ok: false; details: Array<{ path: string; message: string }> };

/**
 * Runs a schema and reports problems in the `details` shape of the API's error response
 * (docs/api/openapi.yaml, ErrorResponse). The api and the dashboard's forms both use it, so a
 * field is described the same way on both sides.
 */
export function validateInput<Schema extends InputSchema>(
  schema: Schema,
  value: unknown,
): InputValidation<ParsedInput<Schema>> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    details: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

export type SourceCreateInput = z.infer<typeof sourceCreateSchema>;
export type SourceUpdateInput = z.infer<typeof sourceUpdateSchema>;
export type DestinationCreateInput = z.infer<typeof destinationCreateSchema>;
export type DestinationUpdateInput = z.infer<typeof destinationUpdateSchema>;
export type ConnectionCreateInput = z.infer<typeof connectionCreateSchema>;
export type ConnectionUpdateInput = z.infer<typeof connectionUpdateSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;
