import { All, Controller, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemDetails } from '@knowscroll/contracts';
import { CONSUME_DATA_EXPORT_LINK, type ConsumeDataExportLink } from '@knowscroll/backend/modules/identity';
import { AUTH_LIMITERS } from '../tokens.js';
import { clientAddress } from './auth-credentials.js';
import type { AuthLimiters } from './auth-rate-limit.js';
import { sendProblem } from './problems.js';

const TOKEN_SHAPE = /^kse_[A-Za-z0-9_-]{43}$/;

/**
 * `GET /auth/exports/:token`: the personal data export, once. The link is the credential (one
 * minute, one download), so a browser follows it without a session or the scope header; it lives
 * under `/auth`, which every world already proxies. The answer is a download, never cached. Only
 * GET redeems it: every other method (HEAD from a link prefetcher included) is a 405 that touches
 * neither the budget nor the file.
 */
@Controller()
export class ExportDownloadController {
  constructor(
    @Inject(AUTH_LIMITERS) private readonly limits: AuthLimiters,
    @Inject(CONSUME_DATA_EXPORT_LINK) private readonly consume: ConsumeDataExportLink,
  ) {}

  @All('/auth/exports/:token')
  async download(@Param('token') token: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    // Express answers HEAD from a GET route; a link prefetcher's HEAD must not spend the one download.
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendProblem(response, problemDetails('METHOD_NOT_ALLOWED'));
      return;
    }
    const wait = this.limits.receiptPerClient.take(clientAddress(request));
    if (wait !== undefined) {
      response.setHeader('retry-after', String(wait));
      sendProblem(response, problemDetails('TOO_MANY_REQUESTS'));
      return;
    }
    const result = TOKEN_SHAPE.test(token) ? await this.consume(token) : ({ kind: 'gone' } as const);
    if (result.kind === 'gone') {
      sendProblem(response, problemDetails('NOT_FOUND'));
      return;
    }
    response.status(200);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="knowscroll-export.json"');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Length', result.bytes.byteLength);
    response.end(Buffer.from(result.bytes));
  }
}
