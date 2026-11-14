// The guard in front of every /api/v1 route: `Authorization: Bearer hdl_<prefix>_<secret>`.
// It finds the key row by its prefix, compares hashes in constant time, and attaches the tenant
// to the request. Spec: docs/SECURITY.md#api-key-handling, docs/adr/0013-auth-scope-cut.md
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { parseApiKey, verifyApiKeyHash } from '@hdl/core';
import type { Logger } from '@hdl/core';
import type { PrismaClient } from '@hdl/database';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../common/api-error.js';
import { LOGGER, PRISMA } from '../tokens.js';
import type { AuthContext } from './auth-context.js';

/** `lastUsedAt` is written at most this often per key, so a busy dashboard costs one UPDATE a minute. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * One body for every failure: no header, a malformed one, an unknown key, a revoked key.
 * A different message per case would tell an attacker which prefixes exist.
 */
const unauthorized = (): ApiError =>
  new ApiError(401, 'UNAUTHORIZED', 'A valid API key is required.');

/** The token of an `Authorization: Bearer <token>` header, or null for anything else. */
export function parseBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = await this.authenticate(request.headers.authorization);
    if (auth === null) throw unauthorized();
    request.auth = auth;
    return true;
  }

  private async authenticate(header: string | string[] | undefined): Promise<AuthContext | null> {
    const presentedKey = parseBearerToken(header);
    if (presentedKey === null) return null;
    // The format check also keeps arbitrary text out of the database lookup.
    const parsed = parseApiKey(presentedKey);
    if (parsed === null) return null;

    // The prefix is not secret; it only finds the row. The hash comparison is the actual check.
    const key = await this.prisma.apiKey.findUnique({
      where: { prefix: parsed.prefix },
      include: { tenant: true },
    });
    if (key === null) return null;
    // Compared with crypto.timingSafeEqual (see the LEARN comment in core's hmac.ts).
    if (!verifyApiKeyHash(presentedKey, key.keyHash)) return null;
    if (key.revokedAt !== null) return null;

    this.touchLastUsed(key.id, key.lastUsedAt);
    return {
      tenant: {
        id: key.tenant.id,
        name: key.tenant.name,
        ingestRateLimit: key.tenant.ingestRateLimit,
      },
      apiKey: { id: key.id, prefix: key.prefix, name: key.name },
    };
  }

  /** Records that the key was used. Not awaited: a request never waits for, or fails on, this write. */
  private touchLastUsed(keyId: string, lastUsedAt: Date | null): void {
    const now = Date.now();
    if (lastUsedAt !== null && now - lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS) return;
    this.prisma.apiKey
      .updateMany({ where: { id: keyId }, data: { lastUsedAt: new Date(now) } })
      .catch((error: unknown) => {
        this.logger.debug(
          { err: error instanceof Error ? error.message : String(error) },
          'Could not update ApiKey.lastUsedAt',
        );
      });
  }
}
