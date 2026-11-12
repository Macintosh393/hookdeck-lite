// Zod schema for Source.verificationConfig: the per-source settings of inbound signature
// verification. Pipeline position: ingest (the api validates it on write and reads it on every webhook).
// Spec: docs/SECURITY.md#modes
import { z } from 'zod';

/** HTTP header names are case-insensitive. We store them lowercased so lookups are a plain key read. */
const headerNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a valid HTTP header name')
  .transform((name) => name.toLowerCase());

const standardWebhooksConfigSchema = z.strictObject({
  mode: z.literal('standard-webhooks'),
});

const genericHmacConfigSchema = z.strictObject({
  mode: z.literal('generic-hmac'),
  /** Header that carries the signature, e.g. "x-hub-signature-256". */
  signatureHeader: headerNameSchema,
  /** Text in front of the signature inside the header, e.g. "sha256=". */
  signaturePrefix: z.string().max(32).optional(),
  signatureEncoding: z.enum(['hex', 'base64']),
  /** Header with a Unix-seconds timestamp. When set, it is part of the signed content. */
  timestampHeader: headerNameSchema.optional(),
});

const noneConfigSchema = z.strictObject({
  mode: z.literal('none'),
});

// A discriminated union reads the `mode` field first and then validates against exactly one
// branch, so error messages name the fields of the chosen mode only.
export const verificationConfigSchema = z.discriminatedUnion('mode', [
  standardWebhooksConfigSchema,
  genericHmacConfigSchema,
  noneConfigSchema,
]);

export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type GenericHmacConfig = z.infer<typeof genericHmacConfigSchema>;
