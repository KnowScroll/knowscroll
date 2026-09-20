/**
 * ADR-0024 section 4 — `GET|HEAD /v1/media/:sha256`. Content-addressed, authenticated media
 * serving. `app.ts` performs authorization (device session, epoch, and an `eligible` or
 * `test_eligible` `generated_reel` referencing the requested media) in one short transaction; this
 * module owns everything AFTER that transaction has committed: locating the file, Range/HEAD
 * handling and the simulated-media marker. No database access happens in this file at all, so it
 * is structurally impossible for it to hold a transaction open while bytes are sent to a slow
 * client (see tests/publication-http.test.ts for a real-socket proof of that property).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors.ts';

/** The path parameter must match this before anything else is done with it (ADR-0024 section 4):
 * never used to build a filesystem path directly, only to look up the owning `media_object` row. */
export const MEDIA_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The exact header name a `test_eligible` (stand-in) response always carries; documented in
 * docs/contracts/bootstrap-http.md so no client can mistake stand-in media for real. Absent
 * entirely on a genuine `eligible` response. */
export const MEDIA_SIMULATED_HEADER = 'x-knowscroll-media-simulated';

/** `KS_MEDIA_ROOT` is deployment configuration (never per-request data), matching the same
 * convention `apps/worker/src/generation/main.ts` uses for the generation worker: an explicit
 * absolute path, defaulting to `$KS_DEV_ROOT/media` when unset. Both processes must agree on where
 * KnowScroll's own media store lives; this is a deliberate small duplication rather than importing
 * a private helper out of a module this lane does not own. */
export function resolveMediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KS_MEDIA_ROOT;
  if (raw !== undefined && raw !== '') {
    if (!raw.startsWith('/')) throw new Error('invalid_config: KS_MEDIA_ROOT must be an absolute path');
    return raw;
  }
  const devRoot = env.KS_DEV_ROOT;
  if (devRoot === undefined || devRoot === '' || !devRoot.startsWith('/')) {
    throw new Error('invalid_config: set KS_MEDIA_ROOT, or KS_DEV_ROOT as an absolute path, before serving media');
  }
  return `${devRoot}/media`;
}

export interface ParsedRange { start: number; end: number }

/**
 * Exactly one `bytes=start-end` range per request (a comma means multiple ranges, which this
 * contract does not support and treats as unsatisfiable, matching `416`). Supports an open end
 * (`start-`) and a suffix range (`-N`, the last N bytes). Any range whose start is at or past the
 * end of the file, or whose bounds are not a valid non-negative integer pair, is refused (`null`),
 * which the caller turns into `416` with `Content-Range: bytes *\/<size>`.
 */
export function parseRangeHeader(header: string, totalSize: number): ParsedRange | null {
  if (header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;
  let start: number;
  let end: number;
  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? totalSize - 1 : Number(endText);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  if (start >= totalSize) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

export interface AuthorizedMedia {
  /** `media_object.storage_key`, already validated by the schema's own CHECK to be derived from
   * the sha256 this request named — never a caller-supplied or engine-reported path. */
  storageKey: string;
  /** True exactly when the authorizing `generated_reel` row's availability was `test_eligible`. */
  simulated: boolean;
}

/**
 * Sends the file named by an already-authorized `storageKey`, entirely outside any database
 * transaction. `404` for a storage key with no regular file on disk (content recorded but not
 * present locally — never fabricated, never a stale success). Range/HEAD both go through the same
 * header-setting path so their headers can never disagree.
 */
/**
 * Every exit below is `return reply.send(...)`, never a bare `reply.send(...)` statement: an async
 * Fastify handler that calls `reply.send()` without returning its result can race Fastify's own
 * post-handler completion (which otherwise treats the handler's `undefined` return value as "send
 * an empty body"), silently truncating the response to `Content-Length: 0` — confirmed directly
 * against this project's installed fastify/light-my-request versions before this was written this
 * way; see this lane's PR for the reproduction.
 */
export async function sendMedia(req: FastifyRequest, reply: FastifyReply, mediaRoot: string, authorized: AuthorizedMedia): Promise<FastifyReply> {
  const absolutePath = join(mediaRoot, authorized.storageKey);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new HttpError(404, 'Media not found');
  }
  if (!fileStat.isFile()) throw new HttpError(404, 'Media not found');
  const totalSize = fileStat.size;

  const rangeHeader = req.headers.range;
  let range: ParsedRange | null = null;
  if (typeof rangeHeader === 'string') {
    range = parseRangeHeader(rangeHeader, totalSize);
    if (range === null) {
      reply.header('Content-Range', `bytes */${totalSize}`);
      throw new HttpError(416, 'Range not satisfiable');
    }
  }

  reply.header('Content-Type', 'video/mp4');
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  if (authorized.simulated) reply.header(MEDIA_SIMULATED_HEADER, 'true');

  if (range) {
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
    reply.header('Content-Length', String(range.end - range.start + 1));
  } else {
    reply.code(200);
    reply.header('Content-Length', String(totalSize));
  }

  if (req.method === 'HEAD') {
    return reply.send();
  }
  return reply.send(range ? createReadStream(absolutePath, { start: range.start, end: range.end }) : createReadStream(absolutePath));
}
