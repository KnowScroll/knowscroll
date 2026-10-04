import type pg from 'pg';

export async function eraseAtlas(
  client: pg.PoolClient,
  universeId: string,
): Promise<void> {
  await client.query('DELETE FROM atlas_delta WHERE universe_id=$1', [
    universeId,
  ]);
  await client.query('DELETE FROM atlas_place WHERE universe_id=$1', [
    universeId,
  ]);
}

export async function exportAtlas(client: pg.PoolClient, universeId: string) {
  const q = async (sql: string) => (await client.query(sql, [universeId])).rows;
  return {
    atlasPlaces:
      await q(`SELECT p.id, c.code AS anchor, p.kind, p.parent_place_id, p.state, p.basis, p.load_bearing, p.policy_version, p.created_at, p.changed_at
      FROM atlas_place p JOIN concept c ON c.id = p.anchor_concept_id WHERE p.universe_id=$1 ORDER BY p.created_at, p.id`),
    atlasDeltas:
      await q(`SELECT id, place_id, kind, causal_class, policy_version, evidence, before, after, created_at
      FROM atlas_delta WHERE universe_id=$1 ORDER BY created_at, id`),
  };
}
