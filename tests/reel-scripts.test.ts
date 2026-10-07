/** #199: reel scripts from Git load the same into every world: added as drafts, approved once the
 * owner's approval is recorded in the file, never changed after loading, and skipped until their
 * Scroll exists in the world. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { loadReelScripts } from '@knowscroll/db/generation/reel-scripts';

const databaseUrl =
  process.env.DATABASE_URL ??
  (() => {
    throw new Error('DATABASE_URL required');
  })();
const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });

function script(assetId: string, id: string, tag: string, approved: boolean) {
  return {
    id,
    authoredBy: 'claude (drafted for the owner)',
    approval: approved
      ? { ref: 'PR #999', approvedBy: 'owner', approvedAt: '2026-10-08' }
      : null,
    brief: {
      version: 1,
      worldId: 'knowscroll-reel-scripts-test',
      narration: [
        { text: `The ${tag} begins.`, claimIds: ['c1'] },
        { text: 'It grows slowly.', claimIds: ['c1'] },
        { text: 'It changes the land.', claimIds: ['c1'] },
        { text: 'It ends where it began.', claimIds: ['c1'] },
      ],
      claims: [{ id: 'c1', role: 'main' }],
      claimSources: [{ claimId: 'c1', assetId, assetRevision: 1 }],
      criteria: {
        mustShow: [
          { id: 's1', text: 'Land.', type: 'presence', claimId: 'c1' },
        ],
        mustNotShow: [{ id: 'n1', text: 'Words.', type: 'presence' }],
        depictionPolicyVersion: 'depiction-v1',
      },
      style: { id: 'calm', version: 1, text: 'Calm.' },
      title: `The ${tag}`,
      summary: `About the ${tag}.`,
    },
  };
}
const state = async (id: string) =>
  (
    await db.query('SELECT review_state FROM generation_brief WHERE id=$1', [
      id,
    ])
  ).rows[0]?.review_state;

test('#199 reel scripts load the same into every world', async () => {
  try {
    const assetId = (
      await db.query<{ id: string }>(
        'SELECT id FROM asset ORDER BY editorial_order LIMIT 1',
      )
    ).rows[0]?.id as string;
    const id = randomUUID();
    assert.deepEqual(
      await loadReelScripts(db, [script(assetId, id, 'glacier', false)]),
      [{ id, outcome: 'added' }],
    );
    assert.equal(
      await state(id),
      'draft',
      'without an approval it stays a draft',
    );
    assert.deepEqual(
      await loadReelScripts(db, [script(assetId, id, 'glacier', true)]),
      [{ id, outcome: 'approved' }],
    );
    assert.equal(await state(id), 'approved');
    assert.deepEqual(
      await loadReelScripts(db, [script(assetId, id, 'glacier', true)]),
      [{ id, outcome: 'unchanged' }],
    );
    await assert.rejects(
      loadReelScripts(db, [script(assetId, id, 'river', true)]),
      /changed after it was loaded/,
    );
    const elsewhere = randomUUID();
    assert.deepEqual(
      await loadReelScripts(db, [
        script(randomUUID(), elsewhere, 'dune', true),
      ]),
      [{ id: elsewhere, outcome: 'waiting_for_scroll' }],
    );
    const untitled = script(assetId, randomUUID(), 'x', true);
    delete (untitled.brief as { title?: string }).title;
    await assert.rejects(loadReelScripts(db, [untitled]), /title and summary/);
  } finally {
    await db.end();
  }
});
