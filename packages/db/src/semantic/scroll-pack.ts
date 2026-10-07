/** #199: model-written Scrolls carried in Git (`content/model-scrolls/*.json`), so every world holds
 * the same library with the same ids, and `main ⊆ stage ⊆ dev` holds for content too. A pack file is
 * what one real writing produced (ADR-0041): the public page's text, the model's reply and the run's
 * record (transport, model, token usage; never a prompt or a key). Each world replays the same
 * deterministic checks (scroll-checks-v2) on that reply and admits it exactly as the writer did; a
 * reply this world's checks refuse is skipped, never forced in. Admission is idempotent per material
 * and request, and the Scroll's id follows from them (`model-scrolls.ts`). */
import { checkMaterialUrl } from '@knowscroll/core/scrolls/material';
import { judgeScrollReply } from '@knowscroll/core/scrolls/writing';
import type pg from 'pg';
import { z } from 'zod';
import { admitModelScroll, loadConceptOffer } from './model-scrolls.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const scrollPackFile = z.strictObject({
  version: z.literal(1),
  plan: z.strictObject({
    url: z.string().url(),
    conceptCodes: z.array(z.string().min(1)).min(1).max(8),
  }),
  identity: z.strictObject({ materialSha256: hex64, requestSha256: hex64 }),
  material: z.strictObject({
    url: z.string().url(),
    title: z.string().nullable(),
    text: z.string().min(1),
    retrievedAt: z.string().min(1),
  }),
  reply: z.string().min(1),
  record: z.strictObject({
    transport: z.enum(['fixture', 'minimax']),
    model: z.string().min(1),
    inputBytes: z.number().int().positive(),
    usage: z.record(z.string(), z.unknown()),
    versions: z.record(z.string(), z.string()),
  }),
});
export type ScrollPackFile = z.infer<typeof scrollPackFile>;

export type ScrollPackLoad = {
  url: string;
  outcome:
    | 'admitted'
    | 'already_decided'
    | 'refused_here'
    | 'host_not_allowed'
    | 'concepts_unknown';
  assetId: string | null;
};

/** Replays one pack file inside the caller's transaction. */
export async function loadScrollPackFile(
  client: pg.PoolClient,
  file: unknown,
): Promise<ScrollPackLoad> {
  const pack = scrollPackFile.parse(file);
  const url = pack.material.url;
  const checked = checkMaterialUrl(url);
  if (!checked.ok) return { url, outcome: 'host_not_allowed', assetId: null };
  const { offered, known } = await loadConceptOffer(
    client,
    pack.plan.conceptCodes,
  );
  if (offered.length !== pack.plan.conceptCodes.length)
    return { url, outcome: 'concepts_unknown', assetId: null };
  const verdict = judgeScrollReply(pack.reply, {
    material: pack.material.text,
    offered: pack.plan.conceptCodes,
    known,
  });
  if (!verdict.ok) return { url, outcome: 'refused_here', assetId: null };
  const decided = await admitModelScroll(client, {
    identity: pack.identity,
    material: { ...pack.material, host: checked.host },
    scroll: verdict.scroll,
    record: pack.record,
  });
  if (decided.status === 'admitted')
    return { url, outcome: 'admitted', assetId: decided.assetId };
  if (decided.status === 'already_decided')
    return { url, outcome: 'already_decided', assetId: decided.assetId };
  return { url, outcome: 'refused_here', assetId: null };
}
