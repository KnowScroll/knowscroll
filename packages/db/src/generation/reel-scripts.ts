/** #199: reel scripts carried in Git (`content/reel-scripts/*.json`), so every world holds the same
 * approved scripts with the same ids and `main ⊆ stage ⊆ dev` holds for content too. A script is a
 * generation brief plus who authored it and, once the owner has approved it in its PR, that
 * approval. Loading is idempotent: an existing script is never changed (briefs are immutable, 0013),
 * and the only update is draft → approved once its approval lands. A script whose Scroll is not in
 * this world yet is skipped and loads on a later deploy. */
import { createHash } from 'node:crypto';
import {
  briefSource,
  type GenerationBrief,
  generationBrief,
} from '@knowscroll/contracts/generation';
import { uuid } from '@knowscroll/contracts/primitives';
import type pg from 'pg';
import { z } from 'zod';

const reelScriptFile = z
  .strictObject({
    id: uuid,
    authoredBy: z.string().min(1).max(200),
    /** Set only once the owner approved the script (its PR); ordering it needs no other go-ahead. */
    approval: z
      .strictObject({
        ref: z.string().min(1).max(500),
        approvedBy: z.literal('owner'),
        approvedAt: z.iso.date(),
      })
      .nullable(),
    brief: generationBrief,
  })
  .superRefine((script, ctx) => {
    if (!script.brief.title || !script.brief.summary)
      ctx.addIssue({
        code: 'custom',
        path: ['brief'],
        message:
          'a reel script carries the title and summary its Reel is shown with',
      });
  });
type ReelScriptFile = z.infer<typeof reelScriptFile>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
/** The same digest `storage.addBrief` stores, so a loaded script and an added brief agree. */
function briefSha256(brief: GenerationBrief): string {
  return createHash('sha256').update(canonical(brief)).digest('hex');
}

export type ReelScriptLoad = {
  id: string;
  outcome: 'added' | 'approved' | 'unchanged' | 'waiting_for_scroll';
};

export async function loadReelScripts(
  db: pg.Pool,
  files: readonly unknown[],
): Promise<ReelScriptLoad[]> {
  const scripts: ReelScriptFile[] = files.map((file) =>
    reelScriptFile.parse(file),
  );
  const results: ReelScriptLoad[] = [];
  for (const script of scripts) {
    const source = briefSource(script.brief);
    const scroll = await db.query(
      'SELECT 1 FROM asset WHERE id=$1 AND revision=$2',
      [source.assetId, source.assetRevision],
    );
    if (scroll.rowCount !== 1) {
      results.push({ id: script.id, outcome: 'waiting_for_scroll' });
      continue;
    }
    const digest = briefSha256(script.brief);
    const existing = (
      await db.query<{ brief_sha256: string; review_state: string }>(
        'SELECT brief_sha256,review_state FROM generation_brief WHERE id=$1',
        [script.id],
      )
    ).rows[0];
    if (existing && existing.brief_sha256 !== digest)
      throw new Error(
        `reel script ${script.id} changed after it was loaded; a changed script needs a new id`,
      );
    if (!existing)
      await db.query(
        `
          INSERT INTO
            generation_brief (
              id,
              source_asset_id,
              source_asset_revision,
              truth_state,
              brief,
              brief_sha256,
              authored_by,
              review_state
            )
          VALUES
            ($1, $2, $3, 'synthesis', $4, $5, $6, 'draft')
        `,
        [
          script.id,
          source.assetId,
          source.assetRevision,
          JSON.stringify(script.brief),
          digest,
          script.authoredBy,
        ],
      );
    const approve =
      script.approval !== null && existing?.review_state !== 'approved';
    if (approve)
      await db.query(
        `UPDATE generation_brief SET review_state='approved' WHERE id=$1 AND review_state='draft'`,
        [script.id],
      );
    results.push({
      id: script.id,
      outcome: !existing ? 'added' : approve ? 'approved' : 'unchanged',
    });
  }
  return results;
}
