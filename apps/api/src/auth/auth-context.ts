// Who is calling: the tenant and API key behind a management request. The ApiKeyGuard puts it
// on the request; controllers read it with @CurrentAuth() and scope every query to tenant.id.
import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AuthContext {
  tenant: { id: string; name: string; ingestRateLimit: number };
  apiKey: { id: string; prefix: string; name: string };
}

// Adds our field to Fastify's request type, so `request.auth` is typed everywhere.
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Controller parameter decorator: the AuthContext of the request. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const { auth } = context.switchToHttp().getRequest<FastifyRequest>();
  // Only reachable if a controller uses @CurrentAuth() without @UseGuards(ApiKeyGuard): a bug.
  if (auth === undefined) throw new Error('@CurrentAuth() used on a route without ApiKeyGuard');
  return auth;
});
