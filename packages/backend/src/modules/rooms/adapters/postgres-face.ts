import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/production-scope.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { BackdropLedgerTx, FaceStore } from '../application/face-ports.js';
import { chargeOf } from '../domain/backdrop-spend.js';
import { attemptStateOf, imageMimeOf, reviewStateOf, topicKindOf } from './columns.js';

/** Held by every transaction that adds to the money ledger, so a check of the cap and its reservation are one step. */
const SPEND_LOCK = 'rooms.backdrop-spend';

const ROOM_COLUMNS = ['room_id', 'slug', 'name', 'topic_kind', 'topic_id'] as const;

const roomOf = (row: { room_id: string; slug: string; name: string; topic_kind: string; topic_id: string }) => ({
  roomId: row.room_id,
  slug: row.slug,
  name: row.name,
  topic: { kind: topicKindOf(row.topic_kind), id: row.topic_id },
});

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

type Trx = Transaction<Database>;

/** The money ledger's reads and its one write, over a transaction that already holds the spend lock. */
function ledgerOver(trx: Trx): BackdropLedgerTx {
  return {
    async recordedSpend() {
      const total = await trx
        .selectFrom('rooms.backdrop_attempts')
        .select(sql<string>`coalesce(sum(charge_micro_usd), 0)`.as('total'))
        .executeTakeFirstOrThrow();
      return Number(total.total);
    },
    async roomState(slug) {
      const room = await trx.selectFrom('rooms.rooms').select(ROOM_COLUMNS).where('slug', '=', slug).executeTakeFirst();
      if (room === undefined) return undefined;
      const approved = await trx
        .selectFrom('rooms.room_identity')
        .select(['revision', 'kit'])
        .where('room_id', '=', room.room_id)
        .where('review_state', '=', 'approved')
        .executeTakeFirst();
      const unresolved = await trx
        .selectFrom('rooms.backdrop_attempts')
        .select((eb) => eb.fn.countAll().as('total'))
        .where('room_id', '=', room.room_id)
        .where('state', 'in', ['dispatched', 'unknown'])
        .executeTakeFirstOrThrow();
      const pending = await trx
        .selectFrom('rooms.room_backdrops')
        .select((eb) => eb.fn.countAll().as('total'))
        .where('room_id', '=', room.room_id)
        .where('review_state', '=', 'pending')
        .executeTakeFirstOrThrow();
      return {
        room: roomOf(room),
        approvedKit: approved === undefined ? undefined : { revision: approved.revision, kit: approved.kit },
        unresolved: Number(unresolved.total),
        pendingBackdrops: Number(pending.total),
      };
    },
    async reserve(attempt) {
      await trx
        .insertInto('rooms.backdrop_attempts')
        .values({
          attempt_id: attempt.attemptId,
          room_id: attempt.roomId,
          kit_revision: attempt.kitRevision ?? null,
          state: 'dispatched',
          model: attempt.model,
          prompt_sha256: attempt.promptSha256,
          estimate_micro_usd: attempt.estimateMicroUsd,
          charge_micro_usd: attempt.estimateMicroUsd,
          price_source: attempt.priceSource,
          price_checked_on: attempt.priceCheckedOn,
          requested_by: attempt.requestedBy,
          dispatched_at: attempt.at,
        })
        .execute();
    },
  };
}

/**
 * Approves or rejects a row that is waiting, and when approving first supersedes the one shown so far (the partial unique
 * index allows one approved row per room). `table` is one of the two review tables; both have the same review columns.
 */
async function decide(
  trx: Trx,
  table: 'rooms.room_identity' | 'rooms.room_backdrops',
  where: { column: 'revision' | 'backdrop_id'; value: number | string; roomId: string },
  decision: 'approved' | 'rejected',
  by: string,
  at: Date,
): Promise<void> {
  if (decision === 'approved')
    await sql`update ${sql.table(table)} set review_state = 'superseded'
      where room_id = ${where.roomId}::uuid and review_state = 'approved'`.execute(trx);
  await sql`update ${sql.table(table)}
    set review_state = ${decision}, reviewed_at = ${at}, reviewed_by = ${by}
    where room_id = ${where.roomId}::uuid and ${sql.ref(where.column)} = ${where.value} and review_state = 'pending'`.execute(
    trx,
  );
}

/** Postgres rows of a room's face (migration 0079). Operator commands only; the API reads the approved kit with the room. */
export function faceStore(db: Kysely<Database>): FaceStore {
  return {
    async roomBySlug(slug) {
      const row = await db.selectFrom('rooms.rooms').select(ROOM_COLUMNS).where('slug', '=', slug).executeTakeFirst();
      return row === undefined ? undefined : roomOf(row);
    },

    async kitState(roomId) {
      const row = await db
        .selectFrom('rooms.room_identity')
        .select([
          sql<number | null>`max(revision)`.as('latest'),
          sql<boolean | null>`bool_or(review_state = 'pending')`.as('pending'),
        ])
        .where('room_id', '=', roomId)
        .executeTakeFirstOrThrow();
      return { nextRevision: (row.latest ?? 0) + 1, pending: row.pending === true };
    },

    async insertKit(scope, kit) {
      const inserted = await productionTransactionOf(scope)
        .insertInto('rooms.room_identity')
        .values({
          room_id: kit.roomId,
          revision: kit.revision,
          kit: JSON.stringify(kit.kit),
          kit_version: kit.kitVersion,
          review_state: 'pending',
          role_version: kit.roleVersion,
          model: kit.model,
          attempt_id: kit.attemptId ?? null,
          proposed_at: kit.at,
        })
        // A proposal already waiting, or the same revision stored by a concurrent run: neither is overwritten.
        .onConflict((conflict) => conflict.doNothing())
        .executeTakeFirst();
      return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async listKits(limit) {
      const rows = await db
        .selectFrom('rooms.room_identity as kit')
        .innerJoin('rooms.rooms as room', 'room.room_id', 'kit.room_id')
        .select([
          'kit.room_id',
          'room.slug',
          'kit.revision',
          'kit.kit',
          'kit.review_state',
          'kit.proposed_at',
          'kit.reviewed_by',
        ])
        .where('kit.review_state', 'in', ['pending', 'approved'])
        .orderBy(sql`kit.review_state = 'pending'`, 'desc')
        .orderBy('kit.proposed_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        roomId: row.room_id,
        slug: row.slug,
        revision: row.revision,
        kit: row.kit,
        reviewState: reviewStateOf(row.review_state),
        proposedAt: asDate(row.proposed_at),
        reviewedBy: row.reviewed_by,
      }));
    },

    async kit(slug, revision) {
      const row = await db
        .selectFrom('rooms.room_identity as kit')
        .innerJoin('rooms.rooms as room', 'room.room_id', 'kit.room_id')
        .select([
          'kit.room_id',
          'room.slug',
          'kit.revision',
          'kit.kit',
          'kit.review_state',
          'kit.proposed_at',
          'kit.reviewed_by',
        ])
        .where('room.slug', '=', slug)
        .where('kit.revision', '=', revision)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            roomId: row.room_id,
            slug: row.slug,
            revision: row.revision,
            kit: row.kit,
            reviewState: reviewStateOf(row.review_state),
            proposedAt: asDate(row.proposed_at),
            reviewedBy: row.reviewed_by,
          };
    },

    decideKit({ slug, revision, decision, by, at }) {
      return withTransaction(db, 'rooms.face', async (trx) => {
        const room = await trx.selectFrom('rooms.rooms').select('room_id').where('slug', '=', slug).executeTakeFirst();
        if (room === undefined) return 'unknown';
        const row = await trx
          .selectFrom('rooms.room_identity')
          .select('review_state')
          .where('room_id', '=', room.room_id)
          .where('revision', '=', revision)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return 'unknown';
        if (row.review_state !== 'pending') return 'not_pending';
        await decide(
          trx,
          'rooms.room_identity',
          { column: 'revision', value: revision, roomId: room.room_id },
          decision,
          by,
          at,
        );
        return 'decided';
      });
    },

    inLedgerTransaction(work) {
      return withTransaction(db, 'rooms.backdrop', async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${SPEND_LOCK}, 0))`.execute(trx);
        return work(ledgerOver(trx));
      });
    },

    settleAttempt(attemptId, settlement) {
      return withTransaction(db, 'rooms.backdrop', async (trx) => {
        const attempt = await trx
          .selectFrom('rooms.backdrop_attempts')
          .select(['room_id', 'estimate_micro_usd'])
          .where('attempt_id', '=', attemptId)
          .where('state', '=', 'dispatched')
          .forUpdate()
          .executeTakeFirst();
        if (attempt === undefined) return false;
        await trx
          .updateTable('rooms.backdrop_attempts')
          .set({
            state: settlement.state,
            charge_micro_usd: chargeOf(settlement.state, attempt.estimate_micro_usd),
            settled_at: settlement.at,
            outcome_code: settlement.code ?? null,
          })
          .where('attempt_id', '=', attemptId)
          .execute();
        if (settlement.state === 'succeeded' && settlement.backdrop !== undefined) {
          const { backdrop } = settlement;
          await trx
            .insertInto('rooms.room_backdrops')
            .values({
              backdrop_id: backdrop.backdropId,
              room_id: attempt.room_id,
              attempt_id: attemptId,
              media_key: backdrop.mediaKey,
              sha256: backdrop.sha256,
              size_bytes: backdrop.sizeBytes,
              mime: backdrop.mime,
              review_state: 'pending',
              created_at: settlement.at,
            })
            .execute();
        }
        return true;
      });
    },

    async markStaleUnknown(olderThan, at) {
      const result = await db
        .updateTable('rooms.backdrop_attempts')
        .set({ state: 'unknown', settled_at: at, outcome_code: 'NO_OUTCOME_RECORDED' })
        .where('state', '=', 'dispatched')
        .where('dispatched_at', '<', olderThan)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    resolveUnknown(input) {
      return withTransaction(db, 'rooms.backdrop', async (trx) => {
        const attempt = await trx
          .selectFrom('rooms.backdrop_attempts')
          .select(['state', 'estimate_micro_usd'])
          .where('attempt_id', '=', input.attemptId)
          .forUpdate()
          .executeTakeFirst();
        if (attempt === undefined) return 'unknown_attempt';
        if (attempt.state !== 'unknown') return 'not_unknown';
        await trx
          .updateTable('rooms.backdrop_attempts')
          .set({
            state: input.resolution,
            charge_micro_usd: input.resolution === 'reconciled' && !input.charged ? 0 : attempt.estimate_micro_usd,
            settled_at: input.at,
            settled_by: input.by,
            note: input.reason,
          })
          .where('attempt_id', '=', input.attemptId)
          .execute();
        return 'resolved';
      });
    },

    async listBackdrops(limit) {
      const rows = await db
        .selectFrom('rooms.room_backdrops as backdrop')
        .innerJoin('rooms.rooms as room', 'room.room_id', 'backdrop.room_id')
        .select([
          'backdrop.backdrop_id',
          'room.slug',
          'backdrop.media_key',
          'backdrop.sha256',
          'backdrop.size_bytes',
          'backdrop.mime',
          'backdrop.review_state',
          'backdrop.created_at',
        ])
        .where('backdrop.review_state', 'in', ['pending', 'approved'])
        .orderBy(sql`backdrop.review_state = 'pending'`, 'desc')
        .orderBy('backdrop.created_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        backdropId: row.backdrop_id,
        slug: row.slug,
        mediaKey: row.media_key,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        mime: imageMimeOf(row.mime),
        reviewState: reviewStateOf(row.review_state),
        createdAt: asDate(row.created_at),
      }));
    },

    async backdrop(backdropId) {
      const row = await db
        .selectFrom('rooms.room_backdrops as backdrop')
        .innerJoin('rooms.rooms as room', 'room.room_id', 'backdrop.room_id')
        .select([
          'backdrop.backdrop_id',
          'room.slug',
          'backdrop.media_key',
          'backdrop.sha256',
          'backdrop.size_bytes',
          'backdrop.mime',
          'backdrop.review_state',
          'backdrop.created_at',
        ])
        .where('backdrop.backdrop_id', '=', backdropId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            backdropId: row.backdrop_id,
            slug: row.slug,
            mediaKey: row.media_key,
            sha256: row.sha256,
            sizeBytes: row.size_bytes,
            mime: imageMimeOf(row.mime),
            reviewState: reviewStateOf(row.review_state),
            createdAt: asDate(row.created_at),
          };
    },

    decideBackdrop({ backdropId, decision, by, at }) {
      return withTransaction(db, 'rooms.face', async (trx) => {
        const row = await trx
          .selectFrom('rooms.room_backdrops')
          .select(['room_id', 'review_state'])
          .where('backdrop_id', '=', backdropId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return 'unknown';
        if (row.review_state !== 'pending') return 'not_pending';
        await decide(
          trx,
          'rooms.room_backdrops',
          { column: 'backdrop_id', value: backdropId, roomId: row.room_id },
          decision,
          by,
          at,
        );
        return 'decided';
      });
    },

    async spend(limit) {
      const totals = await db
        .selectFrom('rooms.backdrop_attempts')
        .select([
          sql<string>`coalesce(sum(charge_micro_usd), 0)`.as('recorded'),
          (eb) => eb.fn.countAll().as('attempts'),
        ])
        .executeTakeFirstOrThrow();
      const unresolved = await db
        .selectFrom('rooms.backdrop_attempts as attempt')
        .innerJoin('rooms.rooms as room', 'room.room_id', 'attempt.room_id')
        .select([
          'attempt.attempt_id',
          'room.slug',
          'attempt.state',
          'attempt.charge_micro_usd',
          'attempt.estimate_micro_usd',
          'attempt.outcome_code',
          'attempt.dispatched_at',
        ])
        .where('attempt.state', 'in', ['dispatched', 'unknown'])
        .orderBy('attempt.dispatched_at')
        .limit(limit)
        .execute();
      return {
        recordedMicroUsd: Number(totals.recorded),
        attempts: Number(totals.attempts),
        unresolved: unresolved.map((row) => ({
          attemptId: row.attempt_id,
          slug: row.slug,
          state: attemptStateOf(row.state),
          chargeMicroUsd: row.charge_micro_usd,
          estimateMicroUsd: row.estimate_micro_usd,
          outcomeCode: row.outcome_code,
          dispatchedAt: asDate(row.dispatched_at),
        })),
      };
    },
  };
}

/** The picture an approved backdrop is served from, by the digest in its address; nothing else is ever served. */
export function readApprovedBackdrop(db: Kysely<Database>) {
  return async (sha256: string) => {
    const row = await db
      .selectFrom('rooms.room_backdrops')
      .select(['media_key', 'mime', 'size_bytes'])
      .where('sha256', '=', sha256)
      .where('review_state', '=', 'approved')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : { key: row.media_key, mime: imageMimeOf(row.mime), size: row.size_bytes };
  };
}
