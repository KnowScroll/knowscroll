import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, transaction, OWNER_ID } from '@knowscroll/db';
import { loadReelScripts } from '@knowscroll/db/generation/reel-scripts';
import { loadSubstrateSeed } from '@knowscroll/db/semantic/seed';
// A journey that exercises reader mechanics over a small, finite library can seed its own fixture
// (KS_SEED_SCROLLS) and skip the substrate (KS_SEED_SUBSTRATE=none), so the product library can grow
// without changing what that journey proves. Product seeding uses the defaults.
const scrollsPath =
  process.env.KS_SEED_SCROLLS || 'content/editorial-scrolls.json';
const substratePath = process.env.KS_SEED_SUBSTRATE || 'content/substrate.json';
const assets = JSON.parse(await readFile(scrollsPath, 'utf8')) as Array<
  Record<string, unknown>
>;
// #131: the editorial substrate (concepts, claims with verified quotes, editorial bridge proposals
// decided by the validator). Idempotent per version; a changed statement or source hash under an
// existing identity is refused, never overwritten. Loaded after the Scrolls it annotates.
const substrate =
  substratePath !== 'none' && existsSync(substratePath)
    ? await readFile(substratePath, 'utf8')
    : null;
// #199: reel scripts in Git, the same in every world. Approved ones may be ordered from the shared
// Reel pool; a world receives a Reel another world ordered once it holds the approved script.
const reelScriptsPath =
  process.env.KS_SEED_REEL_SCRIPTS || 'content/reel-scripts';
const reelScripts =
  reelScriptsPath !== 'none' && existsSync(reelScriptsPath)
    ? await Promise.all(
        (await readdir(reelScriptsPath))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map(async (name) =>
            JSON.parse(await readFile(join(reelScriptsPath, name), 'utf8')),
          ),
      )
    : [];
try {
  await transaction(async (c) => {
    await c.query(
      'INSERT INTO universe(id) VALUES($1) ON CONFLICT DO NOTHING',
      [OWNER_ID],
    );
    await c.query(
      'INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING',
      [OWNER_ID],
    );
    for (const [i, a] of assets.entries())
      await c.query(
        `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
 VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',$7) ON CONFLICT(id) DO NOTHING`,
        [a.assetId, a.title, a.summary, a.body, a.sourceTitle, a.sourceUrl, i],
      );
  });
  console.log(
    'Editorial library installed; existing content and user history preserved.',
  );
  if (substrate !== null) {
    const result = await transaction((c) => loadSubstrateSeed(c, substrate));
    const admitted = result.proposals.filter(
      (p) => p.result.status === 'admitted',
    ).length;
    console.log(
      `Editorial substrate ${result.version}: ${result.status}${result.status === 'loaded' ? `; ${admitted}/${result.proposals.length} editorial bridges admitted` : ''}.`,
    );
  }
  if (reelScripts.length > 0) {
    const loaded = await loadReelScripts(pool, reelScripts);
    const count = (outcome: string) =>
      loaded.filter((entry) => entry.outcome === outcome).length;
    console.log(
      `Reel scripts: ${count('added')} added, ${count('approved')} approved, ${count('unchanged')} unchanged, ${count('waiting_for_scroll')} waiting for their Scroll.`,
    );
  }
} finally {
  await pool.end();
}
