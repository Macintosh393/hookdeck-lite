// GET /api/v1/whoami: says which tenant and key a request belongs to. The dashboard's "enter
// API key" screen calls it to check a key before storing it.
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Whoami } from '@hdl/shared';
import { ApiKeyGuard } from './api-key.guard.js';
import { CurrentAuth } from './auth-context.js';
import type { AuthContext } from './auth-context.js';

@Controller('api/v1/whoami')
@UseGuards(ApiKeyGuard)
export class WhoamiController {
  @Get()
  whoami(@CurrentAuth() auth: AuthContext): Whoami {
    return {
      tenant: auth.tenant,
      // The prefix is the public part of the key. The secret part is never stored or returned.
      apiKey: { prefix: auth.apiKey.prefix, name: auth.apiKey.name },
    };
  }
}
