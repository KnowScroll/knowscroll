/**
 * ADR-0026 section 4 / ADR-0027 — delivery is a port. This slice ships two implementations: the
 * local development sink below, and `AgentMailSender` (`agentmail-sender.ts`) for real delivery.
 * Resolved lazily, exactly like `resolveMediaRoot()` in `media.ts`: a test/journey that never calls
 * `POST /v1/auth/magic-link` never needs `KS_DEV_ROOT` (or the AgentMail variables) set.
 * `apps/api/src/main.ts` already refuses to start any production-mode process before this module
 * would ever run; the production check below enforces the same refusal independently (and is
 * unit-tested directly), because a real deployment must never depend on that being the *only* guard.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentMailSender } from './agentmail-sender.ts';

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

type MailSenderSelection = 'dev-sink' | 'agentmail';

/** `KS_MAIL_SENDER` (ADR-0027 section 4): `'dev-sink'` (the default when unset) or `'agentmail'`.
 * Any other value is a configuration error, not a silent fallback. */
function resolveMailSenderSelection(env: NodeJS.ProcessEnv): MailSenderSelection {
  const raw = env.KS_MAIL_SENDER;
  if (raw === undefined || raw === 'dev-sink') return 'dev-sink';
  if (raw === 'agentmail') return 'agentmail';
  throw new Error(`invalid_config: KS_MAIL_SENDER must be 'dev-sink' or 'agentmail' if set (got ${JSON.stringify(raw)})`);
}

/** `AGENTMAIL_TIMEOUT_MS` is optional local configuration, never required: unset means the
 * documented ~10s default (`AGENTMAIL_TIMEOUT_MS` export in `agentmail-sender.ts`). Exists only so
 * a test can bound how long a stalled-connection scenario takes without changing what production
 * ever does unconfigured. */
function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('invalid_config: AGENTMAIL_TIMEOUT_MS must be a positive number of milliseconds if set');
  }
  return parsed;
}

/** `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` must both be present — read only from this `env`
 * object, never sought elsewhere. `AGENTMAIL_BASE_URL` is ordinary local configuration, not a
 * secret: it exists purely so a test can point this sender at a local fake HTTP server; every real
 * deployment leaves it unset and reaches the real AgentMail host. */
function createConfiguredAgentMailSender(env: NodeJS.ProcessEnv): AgentMailSender {
  const apiKey = env.AGENTMAIL_API_KEY;
  const inboxId = env.AGENTMAIL_INBOX_ID;
  if (!apiKey || !inboxId) {
    throw new Error(
      "invalid_config: AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID must both be set to use the 'agentmail' magic-link sender",
    );
  }
  return new AgentMailSender({
    apiKey,
    inboxId,
    baseUrl: env.AGENTMAIL_BASE_URL,
    timeoutMs: parseTimeoutMs(env.AGENTMAIL_TIMEOUT_MS),
  });
}

/**
 * Selects and constructs the configured `MagicLinkSender` (ADR-0027 section 4). In production mode,
 * `KS_MAIL_SENDER` must be exactly `'agentmail'` with its key and inbox present — there is no
 * fallback to the development sink, so a deployment that cannot send mail refuses to start rather
 * than silently writing links to a local file. Outside production, `'agentmail'` may still be
 * selected explicitly (e.g. to exercise real delivery from a local run); the unset default remains
 * the development sink, which requires `KS_DEV_ROOT` (or `KS_MEDIA_ROOT`'s sibling convention)
 * exactly like `resolveMediaRoot()`.
 */
export function createMagicLinkSender(env: NodeJS.ProcessEnv = process.env): MagicLinkSender {
  const selection = resolveMailSenderSelection(env);

  if (env.NODE_ENV === 'production') {
    if (selection !== 'agentmail') {
      throw new Error(
        "No MagicLinkSender is configured for production; KS_MAIL_SENDER must be 'agentmail' with " +
        'AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID set (ADR-0027 section 4) — production never falls ' +
        'back to the development sink.',
      );
    }
    return createConfiguredAgentMailSender(env);
  }

  if (selection === 'agentmail') return createConfiguredAgentMailSender(env);

  const devRoot = env.KS_DEV_ROOT;
  if (!devRoot || !devRoot.startsWith('/')) {
    throw new Error('invalid_config: KS_DEV_ROOT must be an absolute path for the development magic-link sink');
  }
  return new DevelopmentMagicLinkSink(devRoot);
}
