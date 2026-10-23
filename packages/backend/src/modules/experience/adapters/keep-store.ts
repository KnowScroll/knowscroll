import { sql } from 'kysely';
import { KeepEntryRefSchema, KeepPositionSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
} from '../../../infrastructure/receipts/index.js';
import type { KeepStore } from '../application/keep-ports.js';
export const keepStore: KeepStore = {
  async membership(scope, assetId) {
    const result = await sql<{ asset_id: string; asset_revision: number; saved_entry_id: string }>`
      select asset_id,asset_revision,saved_entry_id from experience.saved_items
      where universe_id=${scope.authority.universeId}::uuid and asset_id=${assetId}::uuid`.execute(
      transactionOf(scope),
    );
    const row = result.rows[0];
    return row
      ? KeepEntryRefSchema.parse({
          assetId: row.asset_id,
          assetRevision: row.asset_revision,
          savedEntryId: row.saved_entry_id,
        })
      : undefined;
  },
  async place(scope, savedEntryId) {
    const result = await sql<{ revision: string; position: unknown }>`select place_revision::text as revision,position
      from experience.saved_places where universe_id=${scope.authority.universeId}::uuid
      and saved_entry_id=${savedEntryId}::uuid`.execute(transactionOf(scope));
    const row = result.rows[0];
    if (!row) return undefined;
    const revision = Number(row.revision),
      position = KeepPositionSchema.safeParse(row.position);
    if (!Number.isSafeInteger(revision) || revision < 1 || !position.success)
      throw new Error('KEEP_PLACE_STATE_INVALID');
    return { revision, position: position.data };
  },
  async write(scope, savedEntryId, base, position) {
    const trx = transactionOf(scope),
      u = scope.authority.universeId;
    const result =
      base === 0
        ? await sql`insert into experience.saved_places(universe_id,saved_entry_id,place_revision,position)
        values(${u}::uuid,${savedEntryId}::uuid,1,${JSON.stringify(position)}::jsonb)
        on conflict(universe_id,saved_entry_id) do nothing returning saved_entry_id`.execute(trx)
        : await sql`update experience.saved_places set place_revision=${base + 1},position=${JSON.stringify(position)}::jsonb
        where universe_id=${u}::uuid and saved_entry_id=${savedEntryId}::uuid and place_revision=${base}
        returning saved_entry_id`.execute(trx);
    if (result.rows.length !== 1) throw new Error('KEEP_PLACE_CAS_INVARIANT');
  },
  findReceipt: findPersonalReceipt,
  beginReceipt: insertPersonalReceipt,
  completeReceipt: (scope, commandId, value) => completePersonalReceipt(scope, commandId, value),
};
