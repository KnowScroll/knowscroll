import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  OFFER_COVER_V2_SCHEMA,
  type ReviewListItem,
  type ReviewReleaseResult,
  type ReviewRejectResult,
  type ReviewShow,
} from '@knowscroll/contracts';
import {
  parseDocumentV2,
  parseDocumentV3,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type {
  IsOperatorAccount,
  OperatorReview,
  ReviewNotFound,
  ReviewTarget,
} from '../application/operator-review.js';
import type { AnswerCheckSummary } from '../domain/answer-check.js';
import type { StoredLibraryCheck } from '../production/library-support-store.js';
import { coverOfDocument } from './offer-cover.js';
import {
  answerCheckOf,
  makeReviewGate,
  readCitedProvenance,
  readListingRows,
  readSupportChecks,
  supportCheckSummaryOf,
  type ListingRow,
  type ReleaseResult,
  type RejectResult,
} from './review-gate.js';

/**
 * What `revision_reviews.decided_by` records for a decision made on the screen: `app:` and a short fingerprint of the account id,
 * so a decision can be tied to the account that made it without keeping an address or an account id in shared content. It never
 * starts with `cli:`, so the support check's replay (D-415) does not count it: the screen shows what the check said, and a
 * decision made with that verdict in view is no blind answer key.
 */
export function deciderOfAccount(accountId: string): string {
  return `app:${createHash('sha256').update(accountId.toLowerCase()).digest('hex').slice(0, 16)}`;
}

const isV3 = (row: ListingRow): boolean => row.document_version === SCROLL_DOCUMENT_V3_SCHEMA_VERSION;

interface ReadDocument {
  readonly version: 'scroll-document.v2' | 'scroll-document.v3';
  readonly document: ScrollDocumentV2 | ScrollDocumentV3;
}

/** The stored document, parsed as the schema the row says it has; `undefined` when it does not parse. */
function readDocument(row: ListingRow): ReadDocument | undefined {
  if (isV3(row)) {
    const parsed = parseDocumentV3(row.document);
    return parsed.kind === 'valid' ? { version: 'scroll-document.v3', document: parsed.document } : undefined;
  }
  const parsed = parseDocumentV2(row.document);
  return parsed.kind === 'valid' ? { version: 'scroll-document.v2', document: parsed.document } : undefined;
}

/** The primary topic of each held revision, by `assetId:revision`. */
async function primaryTopics(db: Kysely<Database>, rows: readonly ListingRow[]): Promise<ReadonlyMap<string, string>> {
  if (rows.length === 0) return new Map();
  const { rows: found } = await sql<{ asset_id: string; asset_revision: number; topic_id: string }>`
    select asset_id, asset_revision, topic_id from content.encounter_topics
    where role = 'primary' and asset_id = any(${[...new Set(rows.map((row) => row.asset_id))]}::uuid[])`.execute(db);
  return new Map(found.map((topic) => [`${topic.asset_id}:${String(topic.asset_revision)}`, topic.topic_id]));
}

const keyOf = (row: { readonly asset_id: string; readonly revision: number }): string =>
  `${row.asset_id}:${String(row.revision)}`;

/** The answer check's one word for the list; a document v3 has no calls, so none ran. */
function answerVerdictOf(check: AnswerCheckSummary | null): ReviewListItem['answerCheck'] {
  return check?.outcome ?? null;
}

function supportVerdictOf(check: StoredLibraryCheck | undefined): ReviewListItem['supportCheck'] {
  return check === undefined ? null : supportCheckSummaryOf(check).verdict;
}

function listItemOf(
  row: ListingRow,
  read: ReadDocument,
  recipe: string | null,
  topic: string | undefined,
  support: StoredLibraryCheck | undefined,
): ReviewListItem {
  return {
    assetId: row.asset_id,
    revision: row.revision,
    title: row.title,
    kicker: read.document.kicker,
    documentVersion: read.version,
    heldAt: row.held_at.toISOString(),
    recipe,
    topic: topic ?? null,
    coverage: row.mapped ? 'mapped' : 'unmapped',
    readingMinutes: read.document.measures.readingMinutes,
    answerCheck: answerVerdictOf(answerCheckOf(row.outcomes)),
    supportCheck: supportVerdictOf(support),
  };
}

/** The passages each part cites, with the title of the page each comes from. Never an address. */
async function citedParts(db: Kysely<Database>, row: ListingRow): Promise<ReviewShow['parts']> {
  const provenance = await readCitedProvenance(db, row.asset_id, row.revision);
  if (provenance === undefined) return [];
  const claims = new Map(provenance.claims.map((claim) => [claim.claimId, claim]));
  const titles = new Map(provenance.sources.map((source) => [source.sourceId, source.title]));
  return provenance.citations.flatMap((entry) => {
    const passages = entry.claimIds.flatMap((id) => {
      const claim = claims.get(id);
      const source = claim === undefined ? undefined : titles.get(claim.sourceId);
      return claim === undefined || source === undefined ? [] : [{ quote: claim.quote, source }];
    });
    return passages.length === 0 ? [] : [{ partId: entry.partId, passages }];
  });
}

/** What the answer check said, with the ids and problems of the flagged calls and none of their text. */
function answerFindingsOf(check: AnswerCheckSummary | null): ReviewShow['answerCheck'] {
  if (check === null) return null;
  const flagsOf = (flags: readonly { readonly id: string; readonly problem?: string }[]) =>
    flags.map((flag) => ({ id: flag.id, problem: flag.problem ?? null }));
  switch (check.outcome) {
    case 'passed':
      return { outcome: 'passed', calls: check.calls, code: null, flags: [] };
    case 'repaired':
      return { outcome: 'repaired', calls: check.calls, code: null, flags: flagsOf(check.firstDraftFlags) };
    case 'flagged':
      return { outcome: 'flagged', calls: null, code: null, flags: flagsOf(check.flags) };
    case 'unchecked':
      return { outcome: 'unchecked', calls: null, code: check.code, flags: flagsOf(check.firstDraftFlags) };
  }
}

/** What the support check said, with the sentences to read first. `null` when it has not run for the revision. */
function supportFindingsOf(check: StoredLibraryCheck | undefined): ReviewShow['supportCheck'] {
  if (check === undefined) return null;
  const summary = supportCheckSummaryOf(check);
  return {
    verdict: summary.verdict,
    checker: summary.checkerVersion,
    policy: summary.policy,
    code: summary.code ?? null,
    counts: {
      sentences: summary.counts.sentences,
      supported: summary.counts.supported,
      unsupported: summary.counts.unsupported,
      unclear: summary.counts.unclear,
      noClaim: summary.counts.noClaim,
    },
    attention: check.sentences.flatMap((sentence) =>
      sentence.outcome === 'unsupported' || sentence.outcome === 'unclear'
        ? [
            {
              partId: sentence.part,
              field: sentence.field,
              n: sentence.n,
              outcome: sentence.outcome,
              text: sentence.text,
              problem: sentence.problem ?? null,
            },
          ]
        : [],
    ),
  };
}

function releaseResultOf(result: ReleaseResult): ReviewReleaseResult | undefined {
  switch (result.kind) {
    case 'released':
      return { outcome: 'released', reason: null, replacedRevision: result.replacedRevision };
    case 'already_released':
      return { outcome: 'already_released', reason: null, replacedRevision: null };
    case 'refused': {
      const { reason } = result;
      // `not_under_review`, and the release policy's own refusals, which a release with no guard cannot give, are not an answer for the screen.
      if (
        reason === 'asset_withdrawn' ||
        reason === 'not_newer_than_served' ||
        reason === 'coverage_missing' ||
        reason === 'revision_rejected'
      )
        return { outcome: 'refused', reason, replacedRevision: null };
      return undefined;
    }
  }
}

function rejectResultOf(result: RejectResult): ReviewRejectResult | 'reason_invalid' | undefined {
  switch (result.kind) {
    case 'rejected':
    case 'already_rejected':
      return { outcome: result.kind, reason: null };
    case 'refused':
      if (result.reason === 'revision_released') return { outcome: 'refused', reason: 'revision_released' };
      return result.reason === 'reason_invalid' ? 'reason_invalid' : undefined;
  }
}

/**
 * Builds the operator's review over the shared content tables (D-138). Reads are plain selects; each decision is the review gate's own
 * transaction under the asset's lock, with the account's {@link deciderOfAccount} as `decided_by`. A revision that is not held is
 * checked first, so release and reject on one that was already decided answer `not_found`, as the screen's list no longer shows it;
 * the gate still decides again under its lock, so two operators acting at once cannot both win.
 */
export function makeOperatorReview(ports: {
  readonly db: Kysely<Database>;
  readonly isOperator: IsOperatorAccount;
}): OperatorReview {
  const { db } = ports;
  const gate = makeReviewGate(db);
  const notOperator: ReviewNotFound = { kind: 'not_found', why: 'not_operator' };
  const notHeld: ReviewNotFound = { kind: 'not_found', why: 'not_held' };

  /** The row of the revision when it is held right now. */
  async function heldRow(target: ReviewTarget): Promise<ListingRow | undefined> {
    const rows = await readListingRows(db, { assetId: target.assetId, revision: target.revision, onlyHeld: false });
    return rows.find((row) => row.state === 'held');
  }

  return {
    async list(accountId) {
      if (!(await ports.isOperator(accountId))) return notOperator;
      const rows = await readListingRows(db, { onlyHeld: true });
      const [supports, topics] = await Promise.all([readSupportChecks(db, rows), primaryTopics(db, rows)]);
      const revisions: ReviewListItem[] = [];
      for (const row of rows) {
        const read = readDocument(row);
        // A revision whose document does not parse is not listed, as `content review-list` does not list it.
        if (read === undefined) continue;
        const recipe = await gate.recipeKeyOf(row.asset_id);
        revisions.push(listItemOf(row, read, recipe, topics.get(keyOf(row)), supports.get(keyOf(row))));
      }
      return { kind: 'listed', revisions };
    },

    async show(accountId, target) {
      if (!(await ports.isOperator(accountId))) return notOperator;
      const row = await heldRow(target);
      if (row === undefined) return notHeld;
      const read = readDocument(row);
      if (read === undefined) return { kind: 'unreadable' };
      const [supports, topics, parts, recipe] = await Promise.all([
        readSupportChecks(db, [row]),
        primaryTopics(db, [row]),
        citedParts(db, row),
        gate.recipeKeyOf(row.asset_id),
      ]);
      const support = supports.get(keyOf(row));
      return {
        kind: 'shown',
        review: {
          assetId: row.asset_id,
          revision: row.revision,
          heldAt: row.held_at.toISOString(),
          recipe,
          topic: topics.get(keyOf(row)) ?? null,
          coverage: row.mapped ? 'mapped' : 'unmapped',
          document: read.document,
          cover: coverOfDocument(read.document, OFFER_COVER_V2_SCHEMA) ?? null,
          parts,
          answerCheck: answerFindingsOf(answerCheckOf(row.outcomes)),
          supportCheck: supportFindingsOf(support),
        },
      };
    },

    async release(accountId, target) {
      if (!(await ports.isOperator(accountId))) return notOperator;
      if ((await heldRow(target)) === undefined) return notHeld;
      const result = releaseResultOf(await gate.release({ ...target, decidedBy: deciderOfAccount(accountId) }));
      if (result === undefined) return notHeld;
      return { kind: 'decided', result, recipe: await gate.recipeKeyOf(target.assetId) };
    },

    async reject(accountId, target, reason) {
      if (!(await ports.isOperator(accountId))) return notOperator;
      if ((await heldRow(target)) === undefined) return notHeld;
      const result = rejectResultOf(await gate.reject({ ...target, reason, decidedBy: deciderOfAccount(accountId) }));
      if (result === undefined) return notHeld;
      if (result === 'reason_invalid') return { kind: 'reason_invalid' };
      return { kind: 'decided', result, recipe: await gate.recipeKeyOf(target.assetId) };
    },
  };
}
