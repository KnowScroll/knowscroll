import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { RoleReceipt } from './types.js';
import { SCROLL_PRODUCTION_VERSION, TOPICS, type ScrollTopic } from './topics.js';

export type CreateJobResult =
  | { readonly kind: 'job'; readonly row: ProductionRow; readonly created: boolean }
  /** A take above 1 may start only after every earlier take was rejected. */
  | { readonly kind: 'take_refused' };

export type ProductionStage = 'research' | 'writer';

export interface ProductionRow {
  readonly id: string;
  readonly topic: ScrollTopic;
  readonly policy_version: string;
  /** Which attempt at the recipe at this version this job is (1 to {@link MAX_TAKES_PER_RECIPE}). */
  readonly take: number;
  readonly scope_generation: number;
  readonly target_revision: number;
  readonly state: 'research' | 'writer' | 'published' | 'rejected' | 'unknown';
  readonly writer_run_id: string;
  readonly research: readonly ResearchPage[];
  /** The passages the published Scroll rests on; null until it is published. */
  readonly claims: unknown;
  readonly writer_output: unknown;
  readonly outcomes: readonly RoleReceipt[];
  readonly asset_id: string | null;
  readonly asset_revision: number | null;
}
/** The private production store. SQL is parameterised; source material is never logged or returned by a client port. */
export function productionStore(db: Kysely<Database>) {
  return {
    /** The recipe's latest take at the current version. */
    async read(topic: ScrollTopic): Promise<ProductionRow | undefined> {
      return (
        await sql<ProductionRow>`select * from content.scroll_production_runs where topic=${topic} and policy_version=${SCROLL_PRODUCTION_VERSION} order by take desc limit 1`.execute(
          db,
        )
      ).rows[0];
    },
    async lock(tx: Transaction<Database>, id: string): Promise<ProductionRow> {
      const row = (
        await sql<ProductionRow>`select * from content.scroll_production_runs where id=${id} for update`.execute(tx)
      ).rows[0];
      if (!row) throw new Error('PRODUCTION_RUN_MISSING');
      return row;
    },
    /**
     * The job of one take, created if it does not exist. Take 1 always may be; a later take only when
     * every earlier take exists and was rejected (never after a published job or an unknown attempt),
     * decided here under the transaction so two senders cannot both start it.
     */
    async create(
      tx: Transaction<Database>,
      topic: ScrollTopic,
      generation: number,
      take: number,
    ): Promise<CreateJobResult> {
      const read = async () =>
        (
          await sql<ProductionRow>`select * from content.scroll_production_runs where topic=${topic} and policy_version=${SCROLL_PRODUCTION_VERSION} and take=${take} for update`.execute(
            tx,
          )
        ).rows[0];
      const existing = await read();
      if (existing) return { kind: 'job', row: existing, created: false };
      if (take > 1) {
        const earlier = (
          await sql<{
            state: string;
          }>`select state from content.scroll_production_runs where topic=${topic} and policy_version=${SCROLL_PRODUCTION_VERSION} and take<${take}`.execute(
            tx,
          )
        ).rows;
        if (earlier.length !== take - 1 || earlier.some((job) => job.state !== 'rejected'))
          return { kind: 'take_refused' };
      }
      const inserted =
        await sql<ProductionRow>`insert into content.scroll_production_runs (id,topic,policy_version,take,target_revision,scope_generation,state,writer_run_id) values (${randomUUID()},${topic},${SCROLL_PRODUCTION_VERSION},${take},(select coalesce((select revision from content.assets where id=${TOPICS[topic].assetId}),0)+1),${generation},'research',${randomUUID()}) on conflict (topic,policy_version,take) do nothing returning *`.execute(
          tx,
        );
      if (inserted.rows[0]) return { kind: 'job', row: inserted.rows[0], created: true };
      const raced = await read();
      if (!raced) throw new Error('PRODUCTION_RUN_MISSING');
      return { kind: 'job', row: raced, created: false };
    },
    async research(tx: Transaction<Database>, id: string, pages: readonly ResearchPage[]): Promise<void> {
      await sql`update content.scroll_production_runs set research=${JSON.stringify(pages)}::jsonb,state='writer' where id=${id} and state='research'`.execute(
        tx,
      );
    },
    async finish(
      tx: Transaction<Database>,
      id: string,
      expectedStage: ProductionStage,
      state: 'published' | 'rejected' | 'unknown',
      receipts: readonly RoleReceipt[],
      publication?: { readonly assetId: string; readonly revision: number },
      published?: { readonly authored: unknown; readonly claims: unknown },
    ): Promise<void> {
      await sql`update content.scroll_production_runs set state=${state},outcomes=outcomes||${JSON.stringify(receipts)}::jsonb,writer_output=${published === undefined ? null : JSON.stringify(published.authored)}::jsonb,claims=${published === undefined ? null : JSON.stringify(published.claims)}::jsonb,asset_id=${publication?.assetId ?? null},asset_revision=${publication?.revision ?? null},completed_at=now() where id=${id} and state=${expectedStage}`.execute(
        tx,
      );
    },
  };
}
