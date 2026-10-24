import { Controller, Get, Header, Inject, Param, Req, Res } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { apiContract, ContentShareTokenSchema } from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { CONVERSATION_USE_CASES, type ConversationUseCases } from '@knowscroll/backend/modules/social';
import { CALLERS, LOG_EVENT } from '../tokens.js';
import { authorityOf, type AuthenticatedCallers, type Caller } from './callers.js';
import { renderLanding, type LandingState } from './share-landing-page.js';
import { socialProblem } from './social-problems.js';

/**
 * The public face of share links, on the app origin where the edge sends `/s/*` (D-008).
 *
 * `POST /s/preview` is the JSON preview (public metadata only, no credentials considered).
 * `GET /s/:token` is the landing page: a small server-rendered HTML page for the web. A person
 * with a session sees a private link they belong to; everyone else sees public metadata or an
 * honest unavailable page. Neither creates a receipt, joins anything or records consumption.
 * The token is the only secret in the path; it is never logged (the route template is) and the
 * page sends no referrer and is never cached or indexed.
 */
@Controller()
export class ShareLandingController {
  constructor(
    @Inject(CONVERSATION_USE_CASES) private readonly useCases: ConversationUseCases,
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
  ) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.publicContentShares.preview)
  previewRoute() {
    return implement(apiContract.publicContentShares.preview).handler(async ({ input }) => {
      const result = await this.useCases.shares.previewPublic(input);
      if (result.kind === 'refused') throw socialProblem('INVALID_REQUEST');
      return result.value;
    });
  }

  @Get('s/:token')
  async landing(@Param('token') token: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-robots-tag', 'noindex, nofollow');
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    let caller: Caller | undefined;
    let state: LandingState;
    try {
      caller = await this.callers.resolve(request.headers);
      state = await this.stateOf(token, caller);
    } catch (error) {
      this.logEvent('http.retryable_failure', { reasonCode: 'landing_failed', error });
      response.status(503).setHeader('retry-after', '5');
      state = { kind: 'try_again' };
    }
    response.type('html').send(renderLanding(state, { signedIn: caller !== undefined }));
  }

  private async stateOf(token: string, caller: Caller | undefined): Promise<LandingState> {
    if (!ContentShareTokenSchema.safeParse(token).success) return { kind: 'unavailable' };
    const body = { version: 'content-share.v1' as const, readId: randomUUID(), token };
    if (caller === undefined) {
      const preview = await this.useCases.shares.previewPublic(body);
      return preview.kind === 'ok' && preview.value.status === 'public_metadata'
        ? { kind: 'public', content: preview.value.content }
        : { kind: 'unavailable' };
    }
    const resolved = await this.useCases.shares.resolve(authorityOf(caller), body);
    if (resolved.kind !== 'ok') return { kind: 'unavailable' };
    if (resolved.value.status === 'public_metadata') return { kind: 'public', content: resolved.value.content };
    if (resolved.value.status === 'conversation')
      return {
        kind: 'conversation',
        content: resolved.value.content,
        conversationId: resolved.value.conversation.conversationId,
      };
    return { kind: 'unavailable' };
  }
}
