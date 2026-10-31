import { Controller, Get, Head, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemDetails } from '@knowscroll/contracts';
import { mediaReadStream, type MediaStore } from '@knowscroll/backend/infrastructure/media-store';
import { READ_ROOM_BACKDROP, type ReadRoomBackdrop } from '@knowscroll/backend/modules/rooms';
import { MEDIA_STORE } from '../modules/media.js';
import { CALLERS } from '../tokens.js';
import type { AuthenticatedCallers } from './callers.js';
import { sendProblem } from './problems.js';

/**
 * The painted backdrop of a room (D-166): `GET /media/room/<sha256>`, on the app origin where the edge already sends
 * `/media/*`. It serves only a backdrop an operator approved, to a signed-in session. The digest is the address, so a
 * replaced picture has a new one and a rejected or replaced picture is not found at its old one. The picture is cached
 * only with revalidation (`private, no-cache` and an ETag): a device keeps the bytes but asks before each use, which is
 * answered from the approval check without sending them again, so a rejection takes effect at the next use instead of
 * after a day. The picture is reviewed art with no text and no faces; it holds nothing of any person.
 */
@Controller()
export class RoomBackdropController {
  constructor(
    @Inject(READ_ROOM_BACKDROP) private readonly backdrops: ReadRoomBackdrop,
    @Inject(MEDIA_STORE) private readonly store: MediaStore | undefined,
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
  ) {}

  @Head('/media/room/:digest')
  head(@Param('digest') digest: string, @Req() request: Request, @Res() response: Response) {
    return this.deliver(digest, request, response);
  }

  @Get('/media/room/:digest')
  get(@Param('digest') digest: string, @Req() request: Request, @Res() response: Response) {
    return this.deliver(digest, request, response);
  }

  private async deliver(digest: string, request: Request, response: Response): Promise<void> {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const notFound = () => {
      response.setHeader('Cache-Control', 'private, no-store');
      sendProblem(response, problemDetails('NOT_FOUND'));
    };
    if (!/^[0-9a-f]{64}$/.test(digest) || this.store === undefined) return notFound();
    const caller = await this.callers.resolve(request.headers);
    const backdrop = caller === undefined ? undefined : await this.backdrops(digest);
    if (backdrop === undefined) return notFound();
    let file;
    try {
      file = await this.store.open(backdrop.key);
    } catch {
      return notFound();
    }
    const close = async () => {
      await file.handle.close().catch(() => undefined);
    };
    if (file.size !== backdrop.size) {
      await close();
      return notFound();
    }
    const etag = `"${digest}"`;
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('Content-Type', backdrop.mime);
    const conditional = request.headers['if-none-match'];
    if (conditional?.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag) === true) {
      await close();
      response.status(304).end();
      return;
    }
    response.status(200);
    response.setHeader('Content-Length', backdrop.size);
    if (request.method === 'HEAD') {
      await close();
      response.end();
      return;
    }
    const stream = mediaReadStream(file);
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
