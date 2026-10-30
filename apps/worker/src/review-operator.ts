import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReviewGate, recipeKeyOfAsset, type ReviewGate } from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A positive revision number from the command line, or `undefined` when it is anything else. */
function parseRevision(raw: string | undefined): number | undefined {
  const revision = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(revision) && revision >= 1 && revision <= 1_000_000 ? revision : undefined;
}

/**
 * The diagnostic record of a decision, next to the `content.revision_reviews` row that holds who, when and
 * why: the recipe key, what happened, the revision and a refusal's code. Never the Scroll or the reason given.
 */
function recordDecision(
  logEvent: LogEvent,
  assetId: string,
  revision: number,
  result: { readonly kind: string; readonly reason?: string },
): void {
  logEvent('content.review_decided', {
    severity: result.kind === 'refused' ? 'warn' : 'info',
    context: recipeKeyOfAsset(assetId) ?? 'unknown_recipe',
    outcome: result.kind,
    revision,
    ...(result.reason === undefined ? {} : { reasonCode: result.reason }),
  });
}

/** Runs one review command over its own database handle. Shared content only: no provider, no personal root. */
async function withReviewGate(
  reasonCode: string,
  logEvent: LogEvent,
  work: (gate: ReviewGate) => Promise<number>,
): Promise<number> {
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      return await work(makeReviewGate(database.db));
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode, error });
    return 1;
  }
}

/**
 * `content review-list [--all]`: the library v2 Scrolls waiting for an operator, with their recipe,
 * revision, title, word count, reading time, picture and coverage. With `--all`, every revision that
 * went through the gate, with who decided and when. Titles and counts only, never body text.
 */
export function reviewListCommand(options: { readonly all: boolean }, print: Print, logEvent: LogEvent) {
  return withReviewGate('review_list_failed', logEvent, async (gate) => {
    const revisions = await gate.list(options);
    print({ command: 'content review-list', all: options.all, count: revisions.length, revisions });
    return 0;
  });
}

/**
 * `content review-show --asset <id> [--revision <n>] [--sources]`: prints the Scroll as plain text for the
 * operator to read on the server. The text goes to the terminal only; it is never logged. With `--sources`,
 * the source passages each part cites follow it.
 */
export function reviewShowCommand(
  options: { readonly asset?: string; readonly revision?: string; readonly sources: boolean },
  print: Print,
  printText: (text: string) => void,
  logEvent: LogEvent,
) {
  const revision = options.revision === undefined ? undefined : parseRevision(options.revision);
  if (
    options.asset === undefined ||
    !ASSET_ID.test(options.asset) ||
    (options.revision !== undefined && revision === undefined)
  ) {
    print({ result: 'usage', usage: 'content review-show --asset <uuid> [--revision <n>] [--sources]' });
    return Promise.resolve(2);
  }
  const assetId = options.asset.toLowerCase();
  return withReviewGate('review_show_failed', logEvent, async (gate) => {
    const shown = await gate.show({
      assetId,
      ...(revision === undefined ? {} : { revision }),
      withSources: options.sources,
    });
    if (shown.kind === 'refused') {
      print({ command: 'content review-show', result: 'refused', reason: shown.reason });
      return 2;
    }
    const { listing } = shown;
    printText(
      `== ${listing.recipe ?? 'unknown recipe'} · asset ${listing.assetId} · revision ${String(listing.revision)} · ${listing.state}\n${shown.text}\n== end`,
    );
    return 0;
  });
}

/**
 * `content release --asset <id> --revision <n>`: serves exactly that held revision. Idempotent. Records
 * who released it and when. Afterwards run `content admit-continuity` and `content readmit-coverage`.
 */
export function releaseCommand(
  options: { readonly asset?: string; readonly revision?: string; readonly decidedBy: string },
  print: Print,
  logEvent: LogEvent,
) {
  const revision = parseRevision(options.revision);
  if (options.asset === undefined || !ASSET_ID.test(options.asset) || revision === undefined) {
    print({ result: 'usage', usage: 'content release --asset <uuid> --revision <n>' });
    return Promise.resolve(2);
  }
  const assetId = options.asset.toLowerCase();
  return withReviewGate('review_release_failed', logEvent, async (gate) => {
    const result = await gate.release({ assetId, revision, decidedBy: options.decidedBy });
    const { kind, ...rest } = result;
    recordDecision(logEvent, assetId, revision, result);
    print({ command: 'content release', result: kind, ...rest });
    return kind === 'refused' ? 2 : 0;
  });
}

/**
 * `content reject --asset <id> --revision <n> --reason <text>`: keeps the held revision out of the library
 * and frees the recipe's next take, so `content produce-library` writes it again. Records who, when
 * and why. Idempotent; the first reason is kept.
 */
export function rejectCommand(
  options: {
    readonly asset?: string;
    readonly revision?: string;
    readonly reason?: string;
    readonly decidedBy: string;
  },
  print: Print,
  logEvent: LogEvent,
) {
  const revision = parseRevision(options.revision);
  if (options.asset === undefined || !ASSET_ID.test(options.asset) || revision === undefined) {
    print({ result: 'usage', usage: 'content reject --asset <uuid> --revision <n> --reason <text>' });
    return Promise.resolve(2);
  }
  const assetId = options.asset.toLowerCase();
  return withReviewGate('review_reject_failed', logEvent, async (gate) => {
    const result = await gate.reject({
      assetId,
      revision,
      reason: options.reason,
      decidedBy: options.decidedBy,
    });
    const { kind, ...rest } = result;
    recordDecision(logEvent, assetId, revision, result);
    print({ command: 'content reject', result: kind, ...rest });
    return kind === 'refused' ? 2 : 0;
  });
}
