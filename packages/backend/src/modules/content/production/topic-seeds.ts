import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { ResearchRefusal, type ResearchPage } from '../../../infrastructure/research/public-pages.js';
import { readCatalogueIn } from '../adapters/catalogue-store.js';
import { recipeBookOf } from '../adapters/stored-recipes.js';
import {
  countFailedRead,
  fitsTable,
  readKnownCandidates,
  readPendingCandidates,
  readSeedSourcesRead,
  recordSeedSource,
  rekeyCandidate,
  settleEligible,
  settleRejected,
} from '../adapters/topic-candidates.js';
import {
  TOPIC_GROWTH_POLICY,
  candidateVerdict,
  cleanTitle,
  seedLinkVerdict,
} from '../domain/catalogue/topic-growth.js';
import { evidencePassageCount } from './evidence.js';

/** Reads one research page with its links: `fetchResearchWithLinks` over the real network, or a fixture's. Must run outside a transaction. */
export type ReadResearchPage = (
  url: string,
) => Promise<{ readonly page: ResearchPage; readonly links: readonly string[] }>;

export interface SeedTopicCandidatesDependencies {
  readonly db: Kysely<Database>;
  readonly read: ReadResearchPage;
}

/** What one seeding step did, in counts. */
export interface SeedResult {
  /** Research pages whose links were read. */
  readonly sourcesRead: number;
  /** New candidates found by following them (pending). */
  readonly found: number;
  /** Candidate pages read this step, and how each came out. */
  readonly evaluated: number;
  readonly eligible: number;
  readonly rejected: number;
  /** Reads that failed in a way that may pass: the page stays pending and is tried again, a few times. */
  readonly deferred: number;
}

/** An address without the trailing slash of a path (the link reader's own canonical form); the root keeps its slash. */
const withoutSlash = (url: string): string =>
  url.length > 1 && url.endsWith('/') && new URL(url).pathname.length > 1 ? url.slice(0, -1) : url;

/** A refusal of the fetch that may pass on another day: the network, not the page. */
const TRANSIENT = new Set(['dns_timeout', 'request_timeout', 'network_failed', 'http_refused']);

/**
 * The pages whose links code reads for candidates (#674, D-422): every research page of a recipe that is not retired, the plan's own
 * recipes and the stored ones, so a page is a source only because the library already accepted it for a Scroll. Sorted, so which pages a
 * pass reads is the same wherever it runs.
 */
async function sourcePagesOf(db: Kysely<Database>): Promise<readonly string[]> {
  const recipes = await recipeBookOf(db).all();
  // An address the tables cannot hold cannot be a source: it is left out, as it could never be recorded and would stop every pass.
  return [
    ...new Set(
      recipes.filter((recipe) => recipe.status !== 'retired').flatMap((recipe) => recipe.pages.filter(fitsTable)),
    ),
  ].sort();
}

/**
 * The seeding step of topic growth (#674, D-422): candidates by code only. It reads the links of the research pages already accepted for
 * recipes (at most {@link TOPIC_GROWTH_POLICY.sourcesPerPass} that have not been read), keeps the links that name an article of a reviewed
 * host, that are not a recipe's own page and not a candidate already (at most {@link TOPIC_GROWTH_POLICY.candidatesPerSource} a page),
 * stores them as `pending`, then reads up to {@link TOPIC_GROWTH_POLICY.readsPerPass} pending candidates and decides each by
 * code: a namespace page, a disambiguation, a list, a stub (too few passages for a writer) or a topic again (its title shares the words of
 * an existing topic's label) is `rejected` with the code, anything else is `eligible`. No person, no demand and no model is involved, and a
 * host not on the research allow-list is never fetched, because every address passes the research URL rule before any network use.
 *
 * Every read is a network wait and runs outside any transaction; each result is stored by one short statement. A page that cannot be
 * read is rejected with the fetch's code, except where the network may be to blame, where it is counted and tried again (a few times).
 * Running it twice reads nothing twice: a source page and a candidate are each read once.
 */
export function makeSeedTopicCandidates(deps: SeedTopicCandidatesDependencies) {
  return async function seedTopicCandidates(signal: AbortSignal): Promise<SeedResult> {
    const counts = { sourcesRead: 0, found: 0, evaluated: 0, eligible: 0, rejected: 0, deferred: 0 };
    const recipePages = await sourcePagesOf(deps.db);
    const alreadyRead = await readSeedSourcesRead(deps.db);
    // A recipe's page may be written with a trailing slash that a link (read without one) does not have: both are the same page.
    const own = new Set(recipePages.map(withoutSlash));

    /** Reads one source page's links and stores the candidates they give. */
    async function seedFromSource(source: string): Promise<void> {
      let links: readonly string[];
      try {
        links = (await deps.read(source)).links;
      } catch (error) {
        // A source that cannot be read is recorded with the code. A refusal of the page is final; one the network may be to blame for is read
        // again after a day. Either way the next pass reads another source.
        const outcome = error instanceof ResearchRefusal ? error.code : 'read_failed';
        await recordSeedSource(deps.db, { pageUrl: source, outcome, links: 0 }, []);
        counts.sourcesRead += 1;
        return;
      }
      const known = await readKnownCandidates(deps.db, links.filter(fitsTable));
      const chosen = links
        .filter(
          (link) =>
            fitsTable(link) && !own.has(withoutSlash(link)) && !known.has(link) && seedLinkVerdict(link) === 'ok',
        )
        .slice(0, TOPIC_GROWTH_POLICY.candidatesPerSource);
      counts.found += await recordSeedSource(
        deps.db,
        { pageUrl: source, outcome: 'read', links: links.length },
        chosen,
      );
      counts.sourcesRead += 1;
    }

    /** Records a source that could not be seeded; `false` when even that fails (the database is the trouble, not the row). */
    async function skipSource(source: string, error: unknown): Promise<boolean> {
      if (error instanceof ResearchRefusal) return false;
      try {
        await recordSeedSource(deps.db, { pageUrl: source, outcome: 'seed_failed', links: 0 }, []);
        return true;
      } catch {
        return false;
      }
    }

    /** Reads one pending candidate's page and decides it. */
    async function evaluate(candidateUrl: string, labels: readonly string[]): Promise<void> {
      let page: ResearchPage;
      try {
        page = (await deps.read(candidateUrl)).page;
      } catch (error) {
        if (error instanceof ResearchRefusal && !TRANSIENT.has(error.code)) {
          await settleRejected(
            deps.db,
            candidateUrl,
            error.code.startsWith('page_') ? (error.code as `page_${string}`) : `page_${error.code}`,
          );
          counts.rejected += 1;
        } else if ((await countFailedRead(deps.db, candidateUrl)) === 'rejected') counts.rejected += 1;
        else counts.deferred += 1;
        return;
      }
      // A page that redirected is the page it redirected to: a recipe's own page, or one that is a candidate already, is not another.
      let pageUrl = candidateUrl;
      if (page.url !== pageUrl) {
        if (own.has(withoutSlash(page.url))) {
          await settleRejected(deps.db, pageUrl, 'recipe_page');
          counts.rejected += 1;
          return;
        }
        if (!fitsTable(page.url) || !(await rekeyCandidate(deps.db, pageUrl, page.url))) {
          await settleRejected(deps.db, pageUrl, 'duplicate_page');
          counts.rejected += 1;
          return;
        }
        pageUrl = page.url;
      }
      const title = cleanTitle(page.title);
      const passages = evidencePassageCount(page);
      const verdict = candidateVerdict(
        { title, lead: page.passages[0]?.text ?? '', evidencePassages: passages },
        labels,
      );
      if (verdict.kind === 'eligible') {
        await settleEligible(deps.db, pageUrl, page, title, passages);
        counts.eligible += 1;
      } else {
        await settleRejected(deps.db, pageUrl, verdict.code, title);
        counts.rejected += 1;
      }
    }

    /** Rejects a candidate that could not be stored; `false` when even that fails (the database is the trouble, not the row). */
    async function rejectBadCandidate(candidateUrl: string, error: unknown): Promise<boolean> {
      if (error instanceof ResearchRefusal) return false;
      try {
        await settleRejected(deps.db, candidateUrl, 'seed_failed');
        return true;
      } catch {
        return false;
      }
    }

    for (const source of recipePages
      .filter((page) => !alreadyRead.has(page))
      .slice(0, TOPIC_GROWTH_POLICY.sourcesPerPass)) {
      if (signal.aborted) break;
      try {
        await seedFromSource(source);
      } catch (error) {
        // A source that cannot be turned into candidates (an address the table refuses, a row that will not store) is recorded as failed for good and
        // skipped: it never stops the pass, and it is not read again every pass for ever.
        if (!(await skipSource(source, error))) throw error;
        counts.sourcesRead += 1;
      }
    }

    const pending = await readPendingCandidates(deps.db, TOPIC_GROWTH_POLICY.readsPerPass);
    if (pending.length === 0) return counts;
    const labels = (await readCatalogueIn(deps.db)).allTopics().map((topic) => topic.label);
    for (const candidate of pending) {
      if (signal.aborted) break;
      counts.evaluated += 1;
      try {
        await evaluate(candidate.pageUrl, labels);
      } catch (error) {
        // A candidate whose page or row will not store is rejected as `seed_failed` and passed over, so one bad row never wedges the queue.
        if (!(await rejectBadCandidate(candidate.pageUrl, error))) throw error;
        counts.rejected += 1;
      }
    }
    return counts;
  };
}
