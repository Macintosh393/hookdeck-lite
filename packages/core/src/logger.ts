// The pino logger factory used by the api, the worker and the scripts, so every process logs the
// same JSON shape with the same redaction rules. Decision: docs/adr/0015-observability.md
import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

/** Field names whose values must never reach a log line (docs/SECURITY.md, threat T10). */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'webhook-signature',
  'signature',
  'secret',
  'secretEnc',
  'signingSecret',
  'signingSecretEnc',
  'apiKey',
  'keyHash',
  'SECRETS_MASTER_KEY',
  'SEED_API_KEY',
] as const;

/**
 * pino's redaction takes fixed paths, not "this key anywhere". We list each sensitive key at the
 * top level and one and two levels down, which covers `{ secret }`, `{ headers: { cookie } }` and
 * `{ req: { headers: { authorization } } }`. Deeper objects should not be logged at all.
 */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const quoted = `["${key}"]`;
  return [quoted, `*${quoted}`, `*.*${quoted}`];
});

export const REDACTED = '[redacted]';

export interface CreateLoggerOptions {
  /** pino level name. `silent` switches logging off (used by the integration tests). */
  level: string;
  /** Appears as `name` on every line: "api", "worker", "seed". */
  name: string;
  /** Human-readable output through pino-pretty. Development only; production logs raw JSON. */
  pretty?: boolean;
  /** Where to write instead of stdout. Tests pass a stream and read the lines back. */
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    name: options.name,
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };

  if (options.destination) return pino(pinoOptions, options.destination);

  if (options.pretty) {
    // A transport runs pino-pretty in a worker thread, so formatting never blocks request handling.
    return pino({ ...pinoOptions, transport: { target: 'pino-pretty' } });
  }

  return pino(pinoOptions);
}
