// In-memory cache of sources by slug, so a webhook costs no SELECT on the hot path.
// Pipeline position: the first step of ingest (docs/ARCHITECTURE.md, sequence diagram 1).
// An entry holds the source's decrypted secret; it lives in this process's memory only.
import { Inject, Injectable } from '@nestjs/common';
import { decryptSecret } from '@hdl/core';
import type { Logger } from '@hdl/core';
import type { PrismaClient } from '@hdl/database';
import { verificationConfigSchema } from '@hdl/shared';
import type { VerificationConfig } from '@hdl/shared';
import { ApiError } from '../common/api-error.js';
import { LOGGER, MASTER_KEY, PRISMA } from '../tokens.js';

/**
 * How long an entry is trusted. The price of the cache: disabling a source, or changing its
 * secret or its tenant's rate limit, takes up to this long to reach ingestion.
 */
export const SOURCE_CACHE_TTL_MS = 30_000;

/** Everything ingestion needs to know about a source, loaded once. */
export interface CachedSource {
  id: string;
  tenantId: string;
  enabled: boolean;
  config: VerificationConfig;
  /** Decrypted. Null for mode `none`. */
  secret: string | null;
  /** Lowercased header that carries the provider's event id, or null (no dedupe). */
  dedupeHeader: string | null;
  /** Tenant.ingestRateLimit: requests per 60-second window. */
  ingestRateLimit: number;
}

interface CacheEntry {
  source: CachedSource;
  expiresAtMs: number;
}

@Injectable()
export class SourceCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Returns the source with this slug, or null if there is none. Throws a 503 ApiError when
   * Postgres cannot be reached (the provider should retry), and a plain Error, which becomes a
   * 500, when the stored row cannot be used (bad config, or a secret that does not decrypt).
   */
  async get(slug: string, nowMs: number = Date.now()): Promise<CachedSource | null> {
    const cached = this.entries.get(slug);
    if (cached && cached.expiresAtMs > nowMs) return cached.source;

    const source = await this.load(slug);
    // Unknown slugs are not cached: anyone can invent slugs, and each would take memory.
    if (source === null) {
      this.entries.delete(slug);
      return null;
    }
    this.entries.set(slug, { source, expiresAtMs: nowMs + SOURCE_CACHE_TTL_MS });
    return source;
  }

  /** Forgets everything. Tests call it after changing a source directly in the database. */
  clear(): void {
    this.entries.clear();
  }

  private async load(slug: string): Promise<CachedSource | null> {
    const row = await this.prisma.source
      .findUnique({
        where: { slug },
        include: { tenant: { select: { ingestRateLimit: true } } },
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Could not load the source from Postgres');
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unable to accept events.');
      });
    if (!row) return null;

    // The `verificationMode` column is the authority on the mode; the JSON holds the mode's settings.
    const storedConfig =
      typeof row.verificationConfig === 'object' && row.verificationConfig !== null
        ? row.verificationConfig
        : {};
    const config = verificationConfigSchema.parse({ ...storedConfig, mode: row.verificationMode });

    const secret =
      row.secretEnc === null
        ? null
        : decryptSecret(row.secretEnc, this.masterKey, {
            tenantId: row.tenantId,
            purpose: 'source-secret',
          });

    return {
      id: row.id,
      tenantId: row.tenantId,
      enabled: row.enabled,
      config,
      secret,
      dedupeHeader: row.dedupeHeader,
      ingestRateLimit: row.tenant.ingestRateLimit,
    };
  }
}
