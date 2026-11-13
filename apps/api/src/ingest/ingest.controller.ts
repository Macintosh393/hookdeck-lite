// POST /in/:sourceSlug, the public ingestion endpoint. This controller deals with HTTP only:
// content type, the raw body, headers. The pipeline itself is in ingest.service.ts.
// Pipeline position: the very first stage (ingest -> fan-out -> delivery -> stream).
import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { IngestResponse } from '@hdl/shared';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../common/api-error.js';
import { IngestService } from './ingest.service.js';
import { isJsonContentType } from './stored-request.js';

@Controller('in')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post(':sourceSlug')
  @HttpCode(202)
  async ingest(
    @Param('sourceSlug') sourceSlug: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<IngestResponse> {
    const contentType = request.headers['content-type'];
    // Fastify itself answers 415 for types it has no parser for. It does have parsers for
    // text/plain and form bodies, so those reach this line and are refused here.
    if (!isJsonContentType(contentType)) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only application/json is accepted.');
    }

    // LEARN: the provider computed its HMAC over the exact bytes it sent. `request.body` is the
    // parsed object, and serializing it again changes whitespace and key order, so the HMAC
    // would not match. `rawBody` is the untouched Buffer (createApp passes `rawBody: true`).
    // See docs/learning/webhooks-101.md#raw-body
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
    }

    // The body is stored as text and later forwarded and signed byte for byte, so the text must
    // turn back into the same bytes. That holds only for valid UTF-8. `fatal` makes the decoder
    // throw on an invalid sequence; `ignoreBOM` keeps a leading byte-order mark instead of dropping it.
    let bodyText: string;
    try {
      bodyText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBody);
    } catch {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request body is not valid UTF-8.');
    }

    return this.ingestService.ingest({
      sourceSlug,
      rawBody,
      bodyText,
      contentType: contentType ?? 'application/json',
      headers: request.headers,
      query: request.query,
      requestId: request.id,
    });
  }
}
