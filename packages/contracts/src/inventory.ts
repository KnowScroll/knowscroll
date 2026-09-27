/**
 * ADR-0025 — additive types for the Reel-inventory slice. Nothing here is re-exported from
 * `./index.ts` (the same convention `generation.ts`/`publication.ts` already follow); callers
 * import this file directly, so no existing consumer of the shared index is affected.
 *
 * ADR-0046 (#164) — the reader's content demands (`GET /v1/inventory`) and, per place, its live
 * demand (`GET /v1/atlas`). Strict: clients refuse an unexpected shape. A demand names a concept
 * and, once bound, a Scroll: never a source, a material page or anything the reader wrote.
 */
import { z } from 'zod';
import type { ScrollAsset } from './index.ts';
import { conceptCode } from './semantic.ts';

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

const id = z.string().uuid();
const reason = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

export const INVENTORY_LIST_LIMIT = 50;

/** The Scroll a demand is bound to, while that binding stands. */
const boundScroll = z.object({ assetId: id, title: z.string().min(1) }).strict();

/** Why the Quartermaster (`quartermaster-v1`) cannot meet a need: no writing route, its budget spent,
 * no allowlisted material for the concept, the Scrolls written for it refused twice, or a request whose
 * one send failed. */
export const cannotMeetReason = z.enum(['no_route', 'no_budget', 'no_material', 'checks_failed', 'request_failed']);
export type CannotMeetReason = z.infer<typeof cannotMeetReason>;

/**
 * One place's live demand. `waiting`: a Scroll is being written (a request was funded or joined).
 * `bound`: one is ready for the reader. `cannot_meet`: nothing more for now, and `reason` says why.
 * `withdrawn`: the last Scroll bound to this need was withdrawn because what it was based on changed.
 */
export const placeDemand = z.object({
  demandId: id,
  status: z.enum(['waiting', 'bound', 'cannot_meet']),
  reason: cannotMeetReason.nullable(),
  scroll: boundScroll.nullable(),
  withdrawn: z.boolean(),
}).strict().refine(d => (d.status === 'bound') === (d.scroll !== null) && (d.status === 'cannot_meet') === (d.reason !== null),
  { message: 'Only a bound demand names a Scroll, and only one that cannot be met a reason' });
export type PlaceDemand = z.infer<typeof placeDemand>;

export const inventoryDemand = z.object({
  demandId: id,
  status: z.enum(['waiting', 'bound', 'cannot_meet', 'cancelled']),
  /** The Quartermaster's latest decision (`quartermaster-v1`). */
  decision: z.enum(['reuse', 'join', 'fund', 'cannot_meet']).nullable(),
  reason: reason.nullable(),
  concept: z.object({ code: conceptCode, name: z.string().min(1).max(80) }).strict(),
  /** What recorded the need: a place read in full, or a continuation into a concept with nothing unseen. */
  causes: z.array(z.enum(['exhaustion', 'branch_gap'])).min(1).max(8),
  scroll: boundScroll.nullable(),
  withdrawn: z.boolean(),
  /** A continuation's gap: the Scroll opens as that continuation, from the exposure it was needed from. */
  origin: z.object({ bridgeId: id, exposureId: id }).strict().nullable(),
  createdAt: z.string().datetime(),
  changedAt: z.string().datetime(),
}).strict();
export type InventoryDemand = z.infer<typeof inventoryDemand>;

export const inventoryResponse = z.object({
  privacyEpoch: z.number().int().min(0).max(2147483647),
  /** This epoch's demands, most recently changed first. */
  demands: z.array(inventoryDemand).max(INVENTORY_LIST_LIMIT),
}).strict();
export type InventoryResponse = z.infer<typeof inventoryResponse>;
