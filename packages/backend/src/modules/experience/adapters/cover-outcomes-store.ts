import { sql } from 'kysely';
import type { CoverPass } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { SessionCovers } from '../application/navigation-ports.js';

/** How long a cover outcome is kept; the table's CHECK holds the same bound. */
export const COVER_OUTCOME_DAYS = 30;
/** How far back a session's dealt covers are read for "more covers": far more hands than one sitting deals. */
const SESSION_OFFERS_READ = 600;

/**
 * `experience.cover_outcomes` (migration 0123): what happened to an offer shown as a cover. Every write is one statement
 * that checks, in SQL, everything a report must satisfy: the offer is the person's, in this privacy epoch, was made
 * while recording was on at this same generation (`recording_offer_origins`), and for a pass was never opened. A report
 * that fails any of these is dropped, never stored. Times come from the database clock.
 */
export async function recordCoverPasses(
  scope: PersonalScopeTx,
  passes: readonly CoverPass[],
  generation: number,
): Promise<void> {
  if (passes.length === 0) return;
  const { universeId, privacyEpoch } = scope.authority;
  const rows = sql.join(passes.map((pass) => sql`(${pass.offerId}::uuid, ${pass.onScreen}::text, ${pass.way}::text)`));
  await sql`
    insert into experience.cover_outcomes
      (universe_id, privacy_epoch, offer_id, asset_id, asset_revision, outcome, on_screen, way, expires_at)
    select o.universe_id, o.privacy_epoch, o.id, o.asset_id, o.asset_revision, 'passed', p.on_screen, p.way,
           now() + make_interval(days => ${COVER_OUTCOME_DAYS}::int)
    from (values ${rows}) as p(offer_id, on_screen, way)
    join experience.offers o on o.universe_id = ${universeId}::uuid and o.privacy_epoch = ${privacyEpoch} and o.id = p.offer_id
    join experience.recording_offer_origins r
      on r.universe_id = o.universe_id and r.offer_id = o.id and r.eligible_generation = ${generation}
    where not exists (
      select 1 from experience.offer_activations a where a.universe_id = o.universe_id and a.offer_id = o.id)
    on conflict (universe_id, offer_id) do nothing`.execute(transactionOf(scope));
}

/**
 * The opened cover of a fresh activation, with the time its cover was on screen clamped to [0, now − offer created] on
 * the database clock, written once in the activation's own transaction. An earlier pass of the same offer (the person
 * went back up to it) becomes the open; an open is never written twice.
 */
export async function recordCoverOpened(
  scope: PersonalScopeTx,
  offerId: string,
  coverMs: number,
  generation: number,
): Promise<void> {
  const { universeId, privacyEpoch } = scope.authority;
  await sql`
    insert into experience.cover_outcomes
      (universe_id, privacy_epoch, offer_id, asset_id, asset_revision, outcome, cover_ms, expires_at)
    select o.universe_id, o.privacy_epoch, o.id, o.asset_id, o.asset_revision, 'opened',
           least(greatest(${coverMs}::int, 0), floor(extract(epoch from (now() - o.created_at)) * 1000)::int, 900000),
           now() + make_interval(days => ${COVER_OUTCOME_DAYS}::int)
    from experience.offers o
    join experience.recording_offer_origins r
      on r.universe_id = o.universe_id and r.offer_id = o.id and r.eligible_generation = ${generation}
    where o.universe_id = ${universeId}::uuid and o.privacy_epoch = ${privacyEpoch} and o.id = ${offerId}::uuid
    on conflict (universe_id, offer_id) do update
      set outcome = 'opened', on_screen = null, way = null, cover_ms = excluded.cover_ms,
          recorded_at = excluded.recorded_at, expires_at = excluded.expires_at
      where experience.cover_outcomes.outcome = 'passed'`.execute(transactionOf(scope));
}

/**
 * For "more covers": the decision that dealt the session's latest hand, and every asset dealt in this session that was
 * never opened, so another hand does not deal them again. Reads the session's offers newest first (`offers_session_idx`).
 * The offers are kept whether or not recording is on, so this works while paused and stores nothing.
 */
export async function readSessionCovers(scope: PersonalScopeTx, sessionId: string): Promise<SessionCovers> {
  const { universeId, privacyEpoch } = scope.authority;
  const result = await sql<{ decision_id: string; intent_revision: number; asset_id: string; opened: boolean }>`
    select o.decision_id, o.intent_revision, o.asset_id,
           exists (select 1 from experience.offer_activations a where a.universe_id = o.universe_id and a.offer_id = o.id) as opened
    from experience.offers o
    where o.universe_id = ${universeId}::uuid and o.session_id = ${sessionId}::uuid and o.privacy_epoch = ${privacyEpoch}
    order by o.intent_revision desc, o.id
    limit ${SESSION_OFFERS_READ}`.execute(transactionOf(scope));
  const latest = result.rows[0];
  const opened = new Set(result.rows.filter((row) => row.opened).map((row) => row.asset_id));
  const dealt = [...new Set(result.rows.filter((row) => !row.opened).map((row) => row.asset_id))];
  return {
    ...(latest ? { latest: { decisionId: latest.decision_id, intentRevision: latest.intent_revision } } : {}),
    // An asset opened from any hand of the session is not "dealt and passed over", even if another hand showed it too.
    dealtNotOpened: dealt.filter((assetId) => !opened.has(assetId)),
  };
}

/**
 * Deletes at most `limit` expired rows of the scope's universe and epoch, oldest first, by primary key. `expires_at` is
 * the row's own bound, set at insert and capped by the table's CHECK, so this never touches a live row.
 */
export async function pruneCoverOutcomes(scope: PersonalScopeTx, limit: number): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('COVER_OUTCOMES_PRUNE_LIMIT');
  const { universeId, privacyEpoch } = scope.authority;
  const result = await sql`
    delete from experience.cover_outcomes where (universe_id, offer_id) in (
      select c.universe_id, c.offer_id from experience.cover_outcomes c
      where c.universe_id = ${universeId}::uuid and c.privacy_epoch = ${privacyEpoch} and c.expires_at <= now()
      order by c.expires_at, c.offer_id limit ${limit})`.execute(transactionOf(scope));
  return Number(result.numAffectedRows ?? 0);
}
