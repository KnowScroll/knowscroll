/**
 * ADR-0026 section 4 — delivery is a port, and this slice ships only a local development sink.
 * Resolved lazily, exactly like `resolveMediaRoot()` in `media.ts`: a test/journey that never
 * calls `POST /v1/auth/magic-link` never needs `KS_DEV_ROOT` set. `apps/api/src/main.ts` already
 * refuses to start any production-mode process before this module would ever run; the production
 * check below enforces the same refusal independently (and is unit-tested directly), because a
 * real deployment must never depend on that being the *only* guard.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface MagicLinkSender {
  /** `to` is accepted for interface realism (any real provider needs a destination) but the one
   * implementation here never persists or logs it — only `link` is ever written anywhere. */
  send(input: { to: string; link: string }): Promise<void>;
}

/**
 * Writes the confirmation link to a single fixed, mode-0600 file under `KS_DEV_ROOT` and never
 * prints or logs it anywhere else. Holds only the most recent link (never an address, never a
 * growing history of past links/tokens) so nothing sensitive accumulates on disk. The write is
 * atomic (write to a temp file, then rename) so a concurrent reader never observes a partial file.
 */
export class DevelopmentMagicLinkSink implements MagicLinkSender {
  private readonly path: string;

  constructor(devRoot: string) {
    this.path = join(devRoot, 'sign-in', 'magic-link.txt');
  }

  async send(input: { to: string; link: string }): Promise<void> {
    void input.to; // never written, never logged — see class comment.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${input.link}\n`, { mode: 0o600 });
    await rename(tmpPath, this.path);
  }

  /** Test/journey-only accessor for the file path a real deployment would never expose over HTTP. */
  get sinkPath(): string {
    return this.path;
  }
}

/**
 * Refuses to start in production mode unless a real sender is configured — none is implemented in
 * this slice, and no provider credential belongs anywhere in this repository (ADR-0026 section 4),
 * so a production-mode call always throws. In any other mode, requires `KS_DEV_ROOT` (or
 * `KS_MEDIA_ROOT`'s sibling convention) exactly like `resolveMediaRoot()`.
 */
export function createMagicLinkSender(env: NodeJS.ProcessEnv = process.env): MagicLinkSender {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'No MagicLinkSender is configured for production; a real provider must be implemented and ' +
      'configured before deployment (ADR-0026 section 4) — the development sink refuses to run here.',
    );
  }
  const devRoot = env.KS_DEV_ROOT;
  if (!devRoot || !devRoot.startsWith('/')) {
    throw new Error('invalid_config: KS_DEV_ROOT must be an absolute path for the development magic-link sink');
  }
  return new DevelopmentMagicLinkSink(devRoot);
}
