import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ContextItem } from '../../../reasoning/public.js';
import { TOPIC_GROWTH_POLICY, type CandidateRejection } from '../domain/catalogue/topic-growth.js';
import { evidencePassageCount } from '../production/evidence.js';
import { excerptOf } from '../production/recipe-brief.js';
import type { CandidatePage } from './recipe-proposals.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/**
 * The tables of topic growth (#674, D-422, migration 0120): research pages whose links were read, the candidate pages found by following
 * them and what became of each, and the proposing runs. All shared and nonpersonal: a page address, a host, a title and the page's public
 * text. Every function is one short statement or transaction; none holds a lock across a model call or a network wait.
 */

export const CANDIDATE_STATUSES = [
  'pending',
  'eligible',
  'rejected',
  'proposed',
  'refused',
  'admitted',
  'blocked_unknown',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** A candidate page as the step reads it. */
export interface Candidate {
  readonly pageUrl: string;
  readonly host: string;
  readonly status: CandidateStatus;
  readonly verdict: string;
  readonly title?: string;
  /** The page's extracted paragraphs, held while the candidate can still be proposed for or has become a topic. */
  readonly passages?: readonly string[];
  readonly passageCount?: number;
  /** Failed proposing attempts so far (0 to 2). */
  readonly attempts: number;
  /** The UTC day of the attempt in flight, pinned so a redelivery after midnight is the same request. */
  readonly attemptDay?: string;
  readonly topicId?: string;
  readonly createdAt: Date;
}

const COLUMNS = sql`page_url, host, status, verdict, title, passages, passage_count, attempts, attempt_day::text as attempt_day, topic_id, created_at`;
interface CandidateDbRow {
  readonly page_url: string;
  readonly host: string;
  readonly status: CandidateStatus;
  readonly verdict: string;
  readonly title: string | null;
  readonly passages: unknown;
  readonly passage_count: number | null;
  readonly attempts: number;
  readonly attempt_day: string | null;
  readonly topic_id: string | null;
  readonly created_at: Date;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && (value as unknown[]).every((item) => typeof item === 'string');

const candidateOf = (row: CandidateDbRow): Candidate => ({
  pageUrl: row.page_url,
  host: row.host,
  status: row.status,
  verdict: row.verdict,
  ...(row.title === null ? {} : { title: row.title }),
  ...(isStrings(row.passages) ? { passages: row.passages } : {}),
  ...(row.passage_count === null ? {} : { passageCount: row.passage_count }),
  attempts: row.attempts,
  ...(row.attempt_day === null ? {} : { attemptDay: row.attempt_day }),
  ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
  createdAt: row.created_at,
});

/** The hosts and paths a page's address is stored by: its host. */
export const hostOf = (url: string): string => new URL(url).hostname;

/** The refusals of a fetch that may pass: the network's, not the page's. A source that met one is read again after a day. */
const TRANSIENT_OUTCOMES = ['dns_timeout', 'request_timeout', 'network_failed', 'http_refused', 'read_failed'] as const;

/**
 * The research pages whose links have been read and are not to be read again: each is read once. A page that could not be read for a reason
 * that may pass (the network failed, or the host answered with something other than the page) is read again after a day, so one bad hour does not
 * lose a source for good.
 */
export async function readSeedSourcesRead(db: Queryable): Promise<ReadonlySet<string>> {
  const { rows } = await sql<{ page_url: string }>`select page_url from content.topic_seed_sources
    where outcome not in (${sql.join([...TRANSIENT_OUTCOMES])}) or read_at > now() - interval '1 day'`.execute(db);
  return new Set(rows.map((row) => row.page_url));
}

/** Which of these addresses already are candidates, of any status: a page is read, and proposed for, once. */
export async function readKnownCandidates(db: Queryable, urls: readonly string[]): Promise<ReadonlySet<string>> {
  if (urls.length === 0) return new Set();
  const rows = await db
    .selectFrom('content.topic_candidates')
    .select('page_url')
    .where('page_url', 'in', urls)
    .execute();
  return new Set(rows.map((row) => row.page_url));
}

/**
 * Records that a research page's links were read and stores the pages it gave as `pending` candidates, in one transaction. A candidate
 * that already exists is left as it is. Returns how many new candidates there are.
 */
export async function recordSeedSource(
  db: Kysely<Database>,
  source: { readonly pageUrl: string; readonly outcome: string; readonly links: number },
  candidateUrls: readonly string[],
): Promise<number> {
  return withTransaction(db, 'content.topic-seed', async (trx) => {
    let stored = 0;
    for (const url of candidateUrls) {
      const inserted = await trx
        .insertInto('content.topic_candidates')
        .values({
          page_url: url,
          host: hostOf(url),
          source_url: source.pageUrl,
          policy_version: TOPIC_GROWTH_POLICY.version,
        })
        .onConflict((conflict) => conflict.column('page_url').doNothing())
        .returning('page_url')
        .executeTakeFirst();
      if (inserted !== undefined) stored += 1;
    }
    // A source read again after a transient failure replaces its earlier row.
    await trx
      .insertInto('content.topic_seed_sources')
      .values({
        page_url: source.pageUrl,
        host: hostOf(source.pageUrl),
        outcome: source.outcome,
        links: source.links,
        candidates: stored,
      })
      .onConflict((conflict) =>
        conflict.column('page_url').doUpdateSet({
          outcome: source.outcome,
          links: source.links,
          candidates: stored,
          read_at: sql`now()`,
        }),
      )
      .execute();
    return stored;
  });
}

/** The candidates found and not read yet, oldest first. */
export async function readPendingCandidates(db: Queryable, limit: number): Promise<readonly Candidate[]> {
  const { rows } = await sql<CandidateDbRow>`select ${COLUMNS} from content.topic_candidates
    where status = 'pending' order by created_at, page_url limit ${limit}`.execute(db);
  return rows.map(candidateOf);
}

/**
 * A pending candidate whose page redirected is the page it redirected to: the row takes the final address, so there is one row for each
 * canonical page. `false` when a row for that address exists already (the alias is a duplicate of it).
 */
export async function rekeyCandidate(db: Queryable, from: string, to: string): Promise<boolean> {
  const { rows } = await sql<{
    page_url: string;
  }>`update content.topic_candidates set page_url = ${to}, host = ${hostOf(to)}, updated_at = now()
    where page_url = ${from} and status = 'pending'
      and not exists (select 1 from content.topic_candidates other where other.page_url = ${to})
    returning page_url`.execute(db);
  return rows.length === 1;
}

/** A page that was read and passed every filter: its title, its paragraphs and how many evidence passages it gives a writer. */
export async function settleEligible(
  db: Queryable,
  pageUrl: string,
  page: Pick<ResearchPage, 'title' | 'sha256' | 'passages'>,
  title: string,
  passageCount: number,
): Promise<void> {
  await sql`update content.topic_candidates set status = 'eligible', verdict = 'ok', title = ${title.slice(0, 300)},
      passages = ${JSON.stringify(page.passages.map((passage) => passage.text))}::jsonb, passage_count = ${passageCount},
      page_sha256 = ${page.sha256}, updated_at = now()
    where page_url = ${pageUrl} and status = 'pending'`.execute(db);
}

/** A page that was read, or could not be, and may not be proposed for. The page's text is not kept. */
export async function settleRejected(
  db: Queryable,
  pageUrl: string,
  code: CandidateRejection,
  title?: string,
): Promise<void> {
  await sql`update content.topic_candidates set status = 'rejected', verdict = ${code}, passages = null,
      title = ${title === undefined ? null : title.slice(0, 300)}, updated_at = now()
    where page_url = ${pageUrl} and status in ('pending', 'eligible', 'proposed')`.execute(db);
}

/** A read that failed for a reason that may pass: it is counted, and past the policy's number the page is rejected as unreachable. */
export async function countFailedRead(db: Queryable, pageUrl: string): Promise<'pending' | 'rejected'> {
  const { rows } = await sql<{
    fetches: number;
  }>`update content.topic_candidates set fetches = fetches + 1, updated_at = now()
    where page_url = ${pageUrl} and status = 'pending' returning fetches`.execute(db);
  if ((rows[0]?.fetches ?? 0) < TOPIC_GROWTH_POLICY.fetchAttempts) return 'pending';
  await settleRejected(db, pageUrl, 'page_unreachable');
  return 'rejected';
}

export async function readCandidate(db: Queryable, pageUrl: string): Promise<Candidate | undefined> {
  const { rows } = await sql<CandidateDbRow>`select ${COLUMNS} from content.topic_candidates
    where page_url = ${pageUrl}`.execute(db);
  return rows[0] === undefined ? undefined : candidateOf(rows[0]);
}

/** How many candidates wait to be proposed for. */
export async function countEligible(db: Queryable): Promise<number> {
  const { rows } = await sql<{
    n: string;
  }>`select count(*) as n from content.topic_candidates where status = 'eligible'`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The candidate the next proposal is for: a run still in flight first (a pass that stopped between the answer and storing it is resumed
 * on the very same request), then the oldest that is eligible.
 */
export async function readNextToPropose(db: Queryable): Promise<Candidate | undefined> {
  const { rows } = await sql<CandidateDbRow>`select ${COLUMNS} from content.topic_candidates
    where status in ('proposed', 'eligible')
    order by (status = 'proposed') desc, created_at, page_url limit 1`.execute(db);
  return rows[0] === undefined ? undefined : candidateOf(rows[0]);
}

/**
 * Begins a proposing attempt: the candidate is `proposed` and the UTC day of the attempt is pinned (an attempt already in flight keeps its
 * day), so a delivery after midnight is the same request and is answered by the ledger. `undefined` when the candidate can no longer be
 * proposed for.
 */
export async function beginAttempt(
  db: Queryable,
  pageUrl: string,
  today: string,
): Promise<{ readonly day: string; readonly retry: number } | undefined> {
  const { rows } = await sql<{ day: string; retry: number }>`update content.topic_candidates
    set status = 'proposed', attempt_day = coalesce(attempt_day, ${today}::date), updated_at = now()
    where page_url = ${pageUrl} and status in ('eligible', 'proposed')
    returning attempt_day::text as day, attempts as retry`.execute(db);
  return rows[0];
}

/** The candidate's page is admitted as the topic, in the transaction that made the release. */
export async function settleAdmitted(tx: Transaction<Database>, pageUrl: string, topicId: string): Promise<void> {
  await sql`update content.topic_candidates set status = 'admitted', verdict = 'ok', topic_id = ${topicId},
      attempt_day = null, updated_at = now()
    where page_url = ${pageUrl} and status in ('eligible', 'proposed')`.execute(tx);
}

/** The model's answer was not admitted, or it found no fit: the candidate is refused with the code, and its text is dropped. */
export async function settleRefused(tx: Queryable, pageUrl: string, code: string): Promise<void> {
  await sql`update content.topic_candidates set status = 'refused', verdict = ${code}, passages = null, attempt_day = null,
      updated_at = now()
    where page_url = ${pageUrl} and status in ('eligible', 'proposed')`.execute(tx);
}

/**
 * A conclusive failure of an attempt (an answer invalid after its repair, a provider that refused): it is counted and the day is released.
 * The candidate may be asked about again on another day, and past the policy's number it is refused as `model_failed`.
 */
export async function countFailedAttempt(db: Queryable, pageUrl: string): Promise<'eligible' | 'refused'> {
  const { rows } = await sql<{ attempts: number }>`update content.topic_candidates
    set attempts = attempts + 1, attempt_day = null, status = 'eligible', updated_at = now()
    where page_url = ${pageUrl} and status in ('eligible', 'proposed') returning attempts`.execute(db);
  if ((rows[0]?.attempts ?? 0) < TOPIC_GROWTH_POLICY.attemptsPerCandidate) return 'eligible';
  await settleRefused(db, pageUrl, 'model_failed');
  return 'refused';
}

/** An attempt of unknown outcome, or a refusal of the harness that may have reached the provider: never resent, and the candidate is not offered again. */
export async function blockCandidate(db: Queryable, pageUrl: string, code: string): Promise<void> {
  await sql`update content.topic_candidates set status = 'blocked_unknown', verdict = ${code}, updated_at = now()
    where page_url = ${pageUrl} and status in ('eligible', 'proposed')`.execute(db);
}

/** Where a proposing run stands: `open` until a topic is admitted or refused, or its run is closed as failed. */
export type TopicProposalState = 'open' | 'completed' | 'failed';

/** A proposing run as `content.topic_proposals` holds it. */
export interface TopicProposal {
  readonly state: TopicProposalState;
  readonly outcome?: string;
  readonly topicId?: string;
  /** The system ids the model was offered. */
  readonly shortlist: readonly string[];
  /** The frozen context, or `undefined` when the stored value is not a list of items (never for a row this code wrote). */
  readonly items: readonly ContextItem[] | undefined;
}

const isContextItem = (value: unknown): value is ContextItem => {
  const item = value as { readonly ref?: unknown; readonly kind?: unknown; readonly text?: unknown } | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.ref === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.text === 'string'
  );
};

/**
 * The proposing run of a request, created if it does not exist. The first delivery freezes the context and the systems it offers; every
 * later delivery gets that row back, so the request it sends is byte for byte the first one and the harness answers from its ledger.
 */
export async function openTopicProposal(
  db: Queryable,
  run: {
    readonly runId: string;
    readonly pageUrl: string;
    readonly day: string;
    readonly retry: number;
    readonly shortlist: readonly string[];
    readonly items: readonly ContextItem[];
  },
): Promise<TopicProposal> {
  await sql`insert into content.topic_proposals (run_id, page_url, day, retry, shortlist, context)
    values (${run.runId}::uuid, ${run.pageUrl}, ${run.day}::date, ${run.retry}, ${[...run.shortlist]}::text[], ${JSON.stringify(run.items)}::jsonb)
    on conflict (run_id) do nothing`.execute(db);
  return (await readTopicProposal(db, run.runId))!;
}

export async function readTopicProposal(db: Queryable, runId: string): Promise<TopicProposal | undefined> {
  const row = await db
    .selectFrom('content.topic_proposals')
    .select(['state', 'outcome', 'topic_id', 'shortlist', 'context'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const context = row.context as unknown;
  return {
    state: row.state as TopicProposalState,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
    shortlist: row.shortlist,
    items:
      Array.isArray(context) && (context as unknown[]).every(isContextItem) ? (context as ContextItem[]) : undefined,
  };
}

/** Moves a run from `open` to its end, in the transaction that decides it or closes its run. A run that already ended stays as it is. */
export async function settleTopicProposal(
  tx: Queryable,
  runId: string,
  state: Exclude<TopicProposalState, 'open'>,
  outcome: string,
  topicId?: string,
): Promise<void> {
  await sql`update content.topic_proposals set state = ${state}, outcome = ${outcome}, topic_id = ${topicId ?? null},
      updated_at = now()
    where run_id = ${runId}::uuid and state = 'open'`.execute(tx);
}

/** How many proposing runs were started since the given moment: what the daily growth cap counts. */
export async function countProposalsSince(db: Queryable, since: Date): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) as n from content.topic_proposals
    where created_at >= ${since}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The pages the topics that grew from a candidate page hold for their recipes: the candidate page itself, which is what makes a new topic's
 * first recipes possible (the recipe brief role proposes only from pages code already holds). Nothing is fetched here.
 */
export async function readTopicOriginPages(db: Queryable, topicId: string): Promise<readonly CandidatePage[]> {
  const { rows } = await sql<{
    page_url: string;
    title: string | null;
    passages: unknown;
  }>`select page_url, title, passages from content.topic_candidates
    where topic_id = ${topicId} and status = 'admitted' order by created_at, page_url`.execute(db);
  return rows.flatMap((row) => {
    if (!isStrings(row.passages) || row.passages.length === 0) return [];
    const opening = row.passages.find((text) => text.length >= 40) ?? row.passages[0] ?? '';
    return [
      {
        url: row.page_url,
        title: row.title ?? row.page_url,
        passages: evidencePassageCount({ passages: row.passages.map((text) => ({ text })) }),
        excerpt: excerptOf(opening),
      },
    ];
  });
}

/** One row of the operator's list: counts and codes, with the page's address as the handle the operator names it by. No page text. */
export interface CandidateListing {
  readonly pageUrl: string;
  readonly host: string;
  readonly status: CandidateStatus;
  readonly verdict: string;
  readonly attempts: number;
  readonly passages: number | null;
  readonly topicId: string | null;
  readonly createdAt: string;
}

/** Candidates, newest first, optionally of one status. No title and no page text. */
export async function listCandidates(
  db: Queryable,
  options: { readonly status?: CandidateStatus; readonly limit?: number },
): Promise<readonly CandidateListing[]> {
  let query = db
    .selectFrom('content.topic_candidates')
    .select(['page_url', 'host', 'status', 'verdict', 'attempts', 'passage_count', 'topic_id', 'created_at'])
    .orderBy('created_at', 'desc')
    .orderBy('page_url')
    .limit(options.limit ?? 200);
  if (options.status !== undefined) query = query.where('status', '=', options.status);
  return (await query.execute()).map((row) => ({
    pageUrl: row.page_url,
    host: row.host,
    status: row.status as CandidateStatus,
    verdict: row.verdict,
    attempts: row.attempts,
    passages: row.passage_count,
    topicId: row.topic_id,
    createdAt: row.created_at.toISOString(),
  }));
}

/** How many candidates hold each status, over the whole table. */
export async function countCandidates(db: Queryable): Promise<Readonly<Partial<Record<CandidateStatus, number>>>> {
  const { rows } = await sql<{
    status: CandidateStatus;
    n: string;
  }>`select status, count(*) as n from content.topic_candidates group by status`.execute(db);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
}
