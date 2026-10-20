import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type { ClaimPackage } from './roles.js';
import type { RoleReceipt } from './types.js';
import { SCROLL_PRODUCTION_VERSION, TOPICS, type ScrollTopic } from './topics.js';

export type ProductionStage = 'research' | 'claims' | 'writer';

export interface ProductionRow {
  readonly id: string;
  readonly topic: ScrollTopic;
  readonly policy_version: string;
  readonly scope_generation: number;
  readonly target_revision: number;
  readonly state: 'research' | 'claims' | 'writer' | 'published' | 'rejected' | 'unknown';
  readonly claims_run_id: string;
  readonly writer_run_id: string;
  readonly research: readonly ResearchPage[];
  readonly claims: ClaimPackage | null;
  readonly writer_output: unknown;
  readonly outcomes: readonly RoleReceipt[];
  readonly asset_id: string | null;
  readonly asset_revision: number | null;
}
/** The private production store. SQL is parameterised; source material is never logged or returned by a client port. */
export function productionStore(db: Kysely<Database>) {
  return {
    async read(topic: ScrollTopic): Promise<ProductionRow | undefined> {
      return (
        await sql<ProductionRow>`select * from content.scroll_production_runs where topic=${topic} and policy_version=${SCROLL_PRODUCTION_VERSION}`.execute(
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
    async create(
      tx: Transaction<Database>,
      topic: ScrollTopic,
      generation: number,
    ): Promise<{ readonly row: ProductionRow; readonly created: boolean }> {
      const inserted =
        await sql<ProductionRow>`insert into content.scroll_production_runs (id,topic,policy_version,target_revision,scope_generation,state,claims_run_id,writer_run_id) values (${randomUUID()},${topic},${SCROLL_PRODUCTION_VERSION},(select coalesce((select revision from content.assets where id=${TOPICS[topic].assetId}),0)+1),${generation},'research',${randomUUID()},${randomUUID()}) on conflict (topic,policy_version) do nothing returning *`.execute(
          tx,
        );
      if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
      const row = (
        await sql<ProductionRow>`select * from content.scroll_production_runs where topic=${topic} and policy_version=${SCROLL_PRODUCTION_VERSION} for update`.execute(
          tx,
        )
      ).rows[0];
      if (!row) throw new Error('PRODUCTION_RUN_MISSING');
      return { row, created: false };
    },
    async research(tx: Transaction<Database>, id: string, pages: readonly ResearchPage[]): Promise<void> {
      await sql`update content.scroll_production_runs set research=${JSON.stringify(pages)}::jsonb,state='claims' where id=${id} and state='research'`.execute(
        tx,
      );
    },
    async claims(tx: Transaction<Database>, id: string, claims: ClaimPackage, receipt: RoleReceipt): Promise<void> {
      await sql`update content.scroll_production_runs set claims=${JSON.stringify(claims)}::jsonb,state='writer',outcomes=outcomes||${JSON.stringify([receipt])}::jsonb where id=${id} and state='claims'`.execute(
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
      draft?: unknown,
    ): Promise<void> {
      await sql`update content.scroll_production_runs set state=${state},outcomes=outcomes||${JSON.stringify(receipts)}::jsonb,writer_output=${draft === undefined ? null : JSON.stringify(draft)}::jsonb,asset_id=${publication?.assetId ?? null},asset_revision=${publication?.revision ?? null},completed_at=now() where id=${id} and state=${expectedStage}`.execute(
        tx,
      );
    },
  };
}
