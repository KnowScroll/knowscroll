import { Controller, Get, Head, Inject, Param, Req, Res } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request, Response } from 'express';
import { apiContract, problemDetails } from '@knowscroll/contracts';
import { mediaReadStream, type MediaStore } from '@knowscroll/backend/infrastructure/media-store';
import { byteRange } from '@knowscroll/backend/infrastructure/media-store/range';
import { MEDIA_ACCESS, MEDIA_GRANTS, MEDIA_STORE, type MediaAccess, type MediaGrants } from '../modules/media.js';
import { CALLERS } from '../tokens.js';
import { authorityOf, type AuthenticatedCallers } from './callers.js';
import { admittedCaller } from './scope-guard.js';
import { problem, sendProblem } from './problems.js';

@Controller()
export class MediaController {
  constructor(
    @Inject(MEDIA_ACCESS) private readonly access: MediaAccess,
    @Inject(MEDIA_STORE) private readonly store: MediaStore | undefined,
    @Inject(MEDIA_GRANTS) private readonly grants: MediaGrants,
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
  ) {}

  @Implement(apiContract.media.grant)
  grant(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return implement(apiContract.media.grant).handler(async ({ input }) => {
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const caller = admittedCaller(request);
      const media = await this.access(authorityOf(caller), input.exposureId);
      if (!media || !this.store) throw problem('NOT_FOUND');
      const grant = this.grants.mint(caller, input.exposureId, media.sha256);
      return {
        document: media.document,
        path: `/media/${media.sha256}?grant=${grant.token}`,
        expiresAt: grant.expiresAt,
      };
    });
  }

  @Head('/media/:digest')
  head(@Param('digest') digest: string, @Req() request: Request, @Res() response: Response) {
    return this.deliver(digest, request, response);
  }
  @Get('/media/:digest')
  get(@Param('digest') digest: string, @Req() request: Request, @Res() response: Response) {
    return this.deliver(digest, request, response);
  }

  /** A separate reviewed session+grant boundary; the /v1 scope guard is never bypassed. */
  private async deliver(digest: string, request: Request, response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const caller = await this.callers.resolve(request.headers);
    const claim = caller ? this.grants.verify(request.query['grant'], caller) : undefined;
    if (!caller || !claim || claim.sha256 !== digest || !this.store) {
      sendProblem(response, problemDetails('NOT_FOUND'));
      return;
    }
    const media = await this.access(authorityOf(caller), claim.exposure);
    if (!media || media.sha256 !== digest) {
      sendProblem(response, problemDetails('NOT_FOUND'));
      return;
    }
    let file;
    try {
      file = await this.store.open(media.key);
    } catch {
      sendProblem(response, problemDetails('NOT_FOUND'));
      return;
    }
    const close = async () => {
      await file.handle.close().catch(() => undefined);
    };
    if (file.size !== media.size) {
      await close();
      sendProblem(response, problemDetails('NOT_FOUND'));
      return;
    }
    const etag = `"${media.sha256}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'video/mp4');
    const conditional = request.headers['if-none-match'];
    if (
      conditional === '*' ||
      conditional?.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag)
    ) {
      await close();
      response.status(304).end();
      return;
    }
    const ifRange = request.headers['if-range'];
    const range = byteRange(ifRange !== undefined && ifRange !== etag ? undefined : request.headers.range, media.size);
    if (range.kind === 'unsatisfiable') {
      await close();
      response.setHeader('Content-Range', `bytes */${media.size}`);
      response.status(416).end();
      return;
    }
    response.status(range.kind === 'range' ? 206 : 200);
    response.setHeader('Content-Length', range.kind === 'range' ? range.end - range.start + 1 : media.size);
    if (range.kind === 'range') response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${media.size}`);
    if (request.method === 'HEAD') {
      await close();
      response.end();
      return;
    }
    const stream = mediaReadStream(file, range.kind === 'range' ? range : undefined);
    stream.on('error', () => {
      response.destroy();
    });
    response.once('close', () => {
      stream.destroy();
      void close();
    });
    stream.pipe(response);
  }
}
