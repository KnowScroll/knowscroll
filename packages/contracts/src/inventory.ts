/**
 * ADR-0025 — additive types for the Reel-inventory slice. Nothing here is re-exported from
 * `./index.ts` (the same convention `generation.ts`/`publication.ts` already follow); callers
 * import this file directly, so no existing consumer of the shared index is affected.
 */
import { z } from 'zod';
import type { ScrollAsset } from './index.ts';

/** The two consumption objects the feed can be asked for, in the exact spelling `GET /v1/feed`'s
 * own `kinds` query parameter and every stored asset row use. */
export const consumptionKind = z.enum(['Scroll', 'Reel']);
export type FeedKindName = z.infer<typeof consumptionKind>;

/**
 * Parses `GET /v1/feed`'s optional `kinds` query parameter. Absent means the one-item default
 * `['Scroll']`, so an existing client that never sends `kinds` sees exactly what it sees today. A
 * comma-separated list of known kind names is accepted; anything else — an empty string, an empty
 * segment, an unknown token, a repeated kind — is malformed and returns `null`, which the route
 * turns into a 400 refusal rather than silently dropping or de-duplicating the unrecognized part.
 */
export function parseFeedKinds(raw: string | undefined): FeedKindName[] | null {
  if (raw === undefined) return ['Scroll'];
  if (raw.length === 0) return null;
  const tokens = raw.split(',');
  const seen: FeedKindName[] = [];
  for (const token of tokens) {
    const parsed = consumptionKind.safeParse(token);
    if (!parsed.success || seen.includes(parsed.data)) return null;
    seen.push(parsed.data);
  }
  return seen;
}

/**
 * The wire shape of one minted Reel inventory item. Mirrors `ScrollAsset`'s identity/title/summary/
 * truthState fields, adds nothing from the generation engine's own artifact path, and never carries
 * an engine-reported path anywhere — only the KnowScroll-owned, content-addressed `mediaUrl`.
 */
export const reelAsset = z.object({
  assetId: z.string().uuid(),
  revision: z.number().int().positive(),
  kind: z.literal('Reel'),
  title: z.string(),
  summary: z.string(),
  truthState: z.literal('synthesis'),
  /** Always true (migration 0013's own `generated_label` CHECK enforces this for every stored
   * generated Reel); carried through so a client never has to special-case its absence. */
  generatedLabel: z.literal(true),
  /** True exactly when the bytes came from stand-in providers (ADR-0024's marker, carried onto the
   * inventory identity by migration 0015). */
  simulated: z.boolean(),
  /** The only playable address KnowScroll ever gives out: `/v1/media/:sha256`. Never an engine
   * path, never a filesystem path. */
  mediaUrl: z.string(),
  durationSeconds: z.number().positive(),
  /** `"<width>:<height>"` from the stored ffprobe probe, e.g. `"1080:1920"`. */
  aspect: z.string(),
  /** The single Scroll this Reel's brief drew its claims from — the "sources sheet" entry. */
  sourceTitle: z.string(),
  sourceUrl: z.string(),
}).strict();
export type ReelAssetDisplay = z.infer<typeof reelAsset>;

/** A feed item is either an existing Scroll or a minted Reel; the union is additive and never
 * changes `ScrollAsset` itself. */
export type FeedAsset = ScrollAsset | ReelAssetDisplay;
