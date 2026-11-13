// The two probes. /health is liveness ("is the process alive?") and touches nothing.
// /ready is readiness ("can it do its job right now?") and checks Postgres and Redis.
// They are separate on purpose: docs/adr/0015-observability.md
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { withTimeout } from '@hdl/core';
import type { Redis } from '@hdl/core';
import type { PrismaClient } from '@hdl/database';
import type { HealthResponse, Readiness } from '@hdl/shared';
import type { FastifyReply } from 'fastify';
import { PRISMA, REDIS } from '../tokens.js';

const CHECK_TIMEOUT_MS = 1000;

@Controller()
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('health')
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<Readiness> {
    const [postgres, redis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`, 'postgres check'),
      this.check(() => this.redis.ping(), 'redis check'),
    ]);

    const ready = postgres === 'ok' && redis === 'ok';
    // 503 tells a load balancer to stop sending traffic; the body names the failed check.
    void reply.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, redis } };
  }

  /** Runs one dependency check with a time limit. Any error or timeout counts as "fail". */
  private async check(run: () => Promise<unknown>, label: string): Promise<'ok' | 'fail'> {
    try {
      await withTimeout(run(), CHECK_TIMEOUT_MS, label);
      return 'ok';
    } catch {
      return 'fail';
    }
  }
}
