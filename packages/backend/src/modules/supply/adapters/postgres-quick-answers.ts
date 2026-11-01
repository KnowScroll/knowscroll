import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { QuickAnswerLedger, QuickAnswerRow, QuickAnswerStore } from '../application/quick-answer-ports.js';

/** The person's Quick answers (`supply.quick_answers`): their own rows, every query keyed by their universe. */
export const quickAnswerStore: QuickAnswerStore = {
  async lockCaps(scope) {
    await sql`select pg_advisory_xact_lock(hashtextextended('supply.quick-answers', 0))`.execute(transactionOf(scope));
  },
  async insert(scope, row) {
    await transactionOf(scope)
      .insertInto('supply.quick_answers')
      .values({
        universe_id: scope.authority.universeId,
        id: row.id,
        privacy_epoch: scope.authority.privacyEpoch,
        asset_id: row.assetId,
        asset_revision: row.assetRevision,
        stop_id: row.stopId,
        recording_generation: row.recordingGeneration,
        state: 'waiting',
        passage: row.passage,
        question: row.question ?? null,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
      })
      .execute();
  },
  async read(scope, id) {
    const row = await transactionOf(scope)
      .selectFrom('supply.quick_answers')
      .selectAll()
      .where('universe_id', '=', scope.authority.universeId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      privacyEpoch: row.privacy_epoch,
      assetId: row.asset_id,
      assetRevision: row.asset_revision,
      stopId: row.stop_id,
      recordingGeneration: row.recording_generation,
      state: row.state as QuickAnswerRow['state'],
      passage: row.passage ?? undefined,
      question: row.question ?? undefined,
      shownQuestion: row.shown_question ?? undefined,
      answer: row.answer ?? undefined,
      covered: row.covered ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  },
  async settle(scope, id, settlement, at) {
    const answered = settlement.kind === 'answered';
    const changed = await transactionOf(scope)
      .updateTable('supply.quick_answers')
      .set({
        state: answered ? 'answered' : 'unavailable',
        passage: null,
        question: null,
        shown_question: answered ? settlement.question : null,
        answer: answered ? settlement.answer : null,
        covered: answered ? settlement.covered : null,
        settled_at: at,
      })
      .where('universe_id', '=', scope.authority.universeId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('id', '=', id)
      .where('state', '=', 'waiting')
      .executeTakeFirst();
    return changed.numUpdatedRows === 1n;
  },
  async dismiss(scope, id) {
    await transactionOf(scope)
      .updateTable('supply.quick_answers')
      .set({ state: 'dismissed', passage: null, question: null, shown_question: null, answer: null, covered: null })
      .where('universe_id', '=', scope.authority.universeId)
      .where('id', '=', id)
      .where('state', '<>', 'dismissed')
      .execute();
  },
  async countSince(scope, since) {
    const row = await transactionOf(scope)
      .selectFrom('supply.quick_answers')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('universe_id', '=', scope.authority.universeId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
  async countWaiting(scope, youngerThan) {
    const row = await transactionOf(scope)
      .selectFrom('supply.quick_answers')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('universe_id', '=', scope.authority.universeId)
      .where('state', '=', 'waiting')
      .where('created_at', '>', youngerThan)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
};

/** Quartermaster's ledger of Quick answers (`supply.quick_answer_ledger`): an ID and a time, no person and no words. */
export const quickAnswerLedger: QuickAnswerLedger = {
  async countSince(scope, since) {
    const row = await transactionOf(scope)
      .selectFrom('supply.quick_answer_ledger')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },
  async insert(scope, id) {
    await transactionOf(scope).insertInto('supply.quick_answer_ledger').values({ id }).execute();
  },
};

/**
 * Closes up to `limit` Quick answers that are still `waiting` more than `waitLimitMs` after they were asked: unavailable, with
 * the words the person selected and typed cleared (the row's own check requires it). The clock is the database's. Rows another
 * transaction holds are skipped; the next run takes them.
 */
export const giveUpStaleQuickAnswers =
  (db: Kysely<Database>, waitLimitMs: number) =>
  async (limit: number): Promise<number> => {
    const closed = await withTransaction(db, 'supply.give-up-quick-answers', (trx) =>
      sql`
        update supply.quick_answers
        set state = 'unavailable', passage = null, question = null, settled_at = now()
        where (universe_id, id) in (
          select universe_id, id from supply.quick_answers
          where state = 'waiting' and created_at <= now() - (${waitLimitMs / 1000} * interval '1 second')
          order by created_at
          limit ${limit}
          for update skip locked
        )`.execute(trx),
    );
    return Number(closed.numAffectedRows ?? 0);
  };

/**
 * Deletes up to `limit` Quick answers whose day is over (index `quick_answers_expiry`). The clock is the database's.
 * Rows another transaction holds are skipped, so the purge never waits on an erasure in progress; the next run takes them.
 */
export const purgeExpiredQuickAnswers =
  (db: Kysely<Database>) =>
  async (limit: number): Promise<number> => {
    const deleted = await withTransaction(db, 'supply.purge-quick-answers', (trx) =>
      sql`
        delete from supply.quick_answers
        where (universe_id, id) in (
          select universe_id, id from supply.quick_answers
          where expires_at <= now()
          order by expires_at
          limit ${limit}
          for update skip locked
        )`.execute(trx),
    );
    return Number(deleted.numAffectedRows ?? 0);
  };
