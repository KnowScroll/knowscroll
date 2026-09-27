/**
 * Moves one universe's recorded history back a day in a disposable `knowscroll_test_*` database, so a
 * test or a device session can have had a "yesterday" (the places and Idea Rooms journeys; the
 * callers check the database). An Ask is an immutable fact (migration 0009): its guard is lifted for
 * exactly this update, inside the caller's transaction, and the transaction restores it. A history
 * with no Ask (`scripts/atlas/seed-day-old-history.ts`, `tests/helpers/reading.ts`' anchorGravity)
 * needs no guard lifted, so those move their rows with a plain update.
 */
import type pg from 'pg';

export async function backdateOneDay(client: pg.ClientBase, universeId: string): Promise<void> {
  await client.query('ALTER TABLE ledger DISABLE TRIGGER ask_ledger_no_update');
  await client.query("UPDATE ledger SET created_at = created_at - interval '1 day' WHERE universe_id=$1", [universeId]);
  await client.query('ALTER TABLE ledger ENABLE TRIGGER ask_ledger_no_update');
}
