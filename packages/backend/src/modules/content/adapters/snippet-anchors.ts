import { ReelDocumentSchema, MIN_SNIPPET_RANGE_MS } from '@knowscroll/contracts';
import {
  deriveAnchorMap,
  describeBlockState,
  repointLocator,
  validateLocator,
  type ScrollDocument,
  type ScrollLocator,
} from '@knowscroll/scroll-model';
import { admitDocument } from '@knowscroll/scroll-model/admission';
import type { Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { reelRangeHolds } from '../domain/snippets.js';
import type {
  ContentLocation,
  ContentRef,
  ResolveSnippetAnchor,
  SnippetAnchorInput,
  SnippetResolution,
  StoredSnippetAnchor,
  ValidateSnippetAnchor,
} from '../public.js';

interface Head {
  readonly kind: 'reel' | 'scroll';
  readonly status: string;
  readonly revision: number;
}

async function readHead(trx: Transaction<Database>, assetId: string): Promise<Head | undefined> {
  const row = await trx
    .selectFrom('content.assets')
    .select(['kind', 'status', 'revision'])
    .where('id', '=', assetId)
    .executeTakeFirst();
  return row !== undefined && (row.kind === 'reel' || row.kind === 'scroll') ? { ...row, kind: row.kind } : undefined;
}

/** The duration of an exact Reel revision, from its stored document. */
async function readReelDuration(trx: Transaction<Database>, ref: ContentRef): Promise<number | undefined> {
  const row = await trx
    .selectFrom('content.asset_revisions')
    .select('document')
    .where('asset_id', '=', ref.assetId)
    .where('revision', '=', ref.assetRevision)
    .where('document_version', '=', 'reel-document.v1')
    .executeTakeFirst();
  const parsed = row === undefined ? undefined : ReelDocumentSchema.safeParse(row.document);
  if (!parsed?.success) return undefined;
  const document = parsed.data;
  return document.assetId.toLowerCase() === ref.assetId && document.revision === ref.assetRevision
    ? document.durationMs
    : undefined;
}

/**
 * An exact Scroll revision, admitted again from its stored bytes: integrity, measures and bounds are
 * verified, so a snippet can never anchor into a document the platform would not serve.
 */
async function readScrollDocument(trx: Transaction<Database>, ref: ContentRef): Promise<ScrollDocument | undefined> {
  const row = await trx
    .selectFrom('content.asset_revisions')
    .select(['document', 'document_sha256'])
    .where('asset_id', '=', ref.assetId)
    .where('revision', '=', ref.assetRevision)
    .where('document_version', '=', 'scroll-document.v1')
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const result = admitDocument(row.document);
  if (result.kind !== 'valid') return undefined;
  const document = result.document;
  return document.assetId.toLowerCase() === ref.assetId &&
    document.revision === ref.assetRevision &&
    document.integrity.sha256 === row.document_sha256
    ? document
    : undefined;
}

/** The scroll-model locator of a stored Scroll anchor on an exact revision. */
function locatorOf(target: ContentRef, anchor: Exclude<StoredSnippetAnchor, { kind: 'reel_range' }>): ScrollLocator {
  const exact = { assetId: target.assetId, revision: target.assetRevision, blockId: anchor.blockId };
  if (anchor.kind === 'scroll_passage')
    return { kind: 'scroll_passage', ...exact, start: anchor.start, end: anchor.end, quoteHash: anchor.quoteHash };
  return {
    kind: 'scroll_block',
    ...exact,
    blockType: anchor.blockType,
    blockVersion: anchor.blockVersion,
    ...(anchor.settings === undefined ? {} : { state: anchor.settings.snapshot }),
  };
}

function validateScrollAnchor(
  document: ScrollDocument,
  target: ContentRef,
  anchor: Exclude<SnippetAnchorInput, { kind: 'reel_range' }>,
): StoredSnippetAnchor | undefined {
  const exact = { assetId: target.assetId, revision: target.assetRevision, blockId: anchor.blockId };
  if (anchor.kind === 'scroll_passage') {
    const outcome = validateLocator(document, { kind: 'scroll_passage', ...exact, ...pickRange(anchor) });
    if (outcome.kind !== 'valid' || outcome.quote === null) return undefined;
    return { ...anchor, quote: outcome.quote };
  }
  const settings = anchor.settings;
  const outcome = validateLocator(
    document,
    {
      kind: 'scroll_block',
      ...exact,
      blockType: anchor.blockType,
      blockVersion: anchor.blockVersion,
      ...(settings === undefined ? {} : { state: settings.snapshot }),
    },
    { personalConsent: settings?.confirmPersonal === true },
  );
  if (outcome.kind !== 'valid') return undefined;
  return {
    kind: 'scroll_block',
    blockId: anchor.blockId,
    blockType: anchor.blockType,
    blockVersion: anchor.blockVersion,
    label: outcome.block.a11y.label,
    ...(settings === undefined
      ? {}
      : {
          settings: {
            snapshot: settings.snapshot,
            description: describeBlockState(outcome.block, settings.snapshot.state),
          },
        }),
  };
}

const pickRange = (anchor: { start: number; end: number; quoteHash: string }) => ({
  start: anchor.start,
  end: anchor.end,
  quoteHash: anchor.quoteHash,
});

/** See `ValidateSnippetAnchor`. Reads shared content only, inside the caller's transaction. */
export const validateSnippetAnchor: ValidateSnippetAnchor = async (scope, target, anchor) => {
  const trx = transactionOf(scope);
  const ref = { assetId: target.assetId.toLowerCase(), assetRevision: target.assetRevision };
  const head = await readHead(trx, ref.assetId);
  if (head?.status !== 'admitted' || head.revision !== ref.assetRevision) return { status: 'unavailable' };
  if (anchor.kind === 'reel_range') {
    if (head.kind !== 'reel') return { status: 'invalid' };
    const durationMs = await readReelDuration(trx, ref);
    if (durationMs === undefined) return { status: 'unavailable' };
    return reelRangeHolds(anchor.startMs, anchor.endMs, durationMs, MIN_SNIPPET_RANGE_MS)
      ? { status: 'valid', anchor: { kind: 'reel_range', startMs: anchor.startMs, endMs: anchor.endMs } }
      : { status: 'invalid' };
  }
  if (head.kind !== 'scroll') return { status: 'invalid' };
  const document = await readScrollDocument(trx, ref);
  if (document === undefined) return { status: 'unavailable' };
  const checked = validateScrollAnchor(document, ref, anchor);
  return checked === undefined ? { status: 'invalid' } : { status: 'valid', anchor: checked };
};

const plain = { mapped: false, settingsReset: false } as const;

function readyOn(
  content: ContentLocation,
  anchor: Extract<SnippetResolution, { status: 'ready' }>['anchor'],
  how: { mapped: boolean; settingsReset: boolean },
): SnippetResolution {
  return { status: 'ready', content, anchor, ...how };
}

/** A correction of a Scroll: the anchor follows the explicit map of the two revisions or is reported changed. */
async function resolveCorrectedScroll(
  trx: Transaction<Database>,
  target: ContentRef,
  anchor: Exclude<StoredSnippetAnchor, { kind: 'reel_range' }>,
  current: ContentLocation,
): Promise<SnippetResolution> {
  const changed: SnippetResolution = { status: 'changed', current };
  const locator = locatorOf(target, anchor);
  const previous = await readScrollDocument(trx, target);
  const next = await readScrollDocument(trx, { assetId: target.assetId, assetRevision: current.assetRevision });
  if (!previous || !next) return changed;
  const map = deriveAnchorMap(previous, next);
  if (map.kind !== 'derived') return changed;
  const outcome = repointLocator(locator, previous, next, map.map);
  if (outcome.kind === 'unavailable' || outcome.kind === 'invalid') return changed;
  const how = { mapped: outcome.kind !== 'same', settingsReset: outcome.kind === 'state-reset' };
  const kept = outcome.locator;
  if (kept.kind === 'scroll_passage')
    return readyOn(current, { kind: 'scroll_passage', blockId: kept.blockId, start: kept.start, end: kept.end }, how);
  return readyOn(
    current,
    { kind: 'scroll_block', blockId: kept.blockId, ...(kept.state === undefined ? {} : { snapshot: kept.state }) },
    how,
  );
}

/** See `ResolveSnippetAnchor`. */
export const resolveSnippetAnchor: ResolveSnippetAnchor = async (scope, target, anchor) => {
  const trx = transactionOf(scope);
  const ref = { assetId: target.assetId.toLowerCase(), assetRevision: target.assetRevision };
  const head = await readHead(trx, ref.assetId);
  if (head?.status !== 'admitted') return { status: 'unavailable' };
  const current: ContentLocation = { kind: head.kind, assetId: ref.assetId, assetRevision: head.revision };
  if (head.revision === ref.assetRevision) {
    const content = current;
    if (anchor.kind === 'reel_range')
      return readyOn(content, { kind: 'reel_range', startMs: anchor.startMs, endMs: anchor.endMs }, plain);
    if (anchor.kind === 'scroll_passage')
      return readyOn(
        content,
        { kind: 'scroll_passage', blockId: anchor.blockId, start: anchor.start, end: anchor.end },
        plain,
      );
    return readyOn(
      content,
      {
        kind: 'scroll_block',
        blockId: anchor.blockId,
        ...(anchor.settings === undefined ? {} : { snapshot: anchor.settings.snapshot }),
      },
      plain,
    );
  }
  if (anchor.kind === 'reel_range') return { status: 'changed', current };
  return resolveCorrectedScroll(trx, ref, anchor, current);
};
