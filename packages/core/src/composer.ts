import type { FeedAsset } from '../../contracts/src/inventory.ts';

/**
 * ADR-0028 (#114/#5): the real Composer. Retrieval stays exactly `feedCandidates()` minus
 * `accounts.kept_asset_ids`, unchanged from the retired bootstrap policy this file used to
 * implement; everything past that — ranking, diversity and the rendered explanation — is a pure
 * function over a signal snapshot the caller fetched with one bounded SQL query
 * (`packages/db/src/composer-signals.ts`) and a registered template it also fetched
 * (`composer_explanation_template`). No database, HTTP, provider or UI import happens here
 * (packages/core/AGENTS.md); the caller (apps/api) owns fetching signals/policy/templates and
 * persisting `decision_signal` rows that record exactly this function's own output, so a later
 * reader can recompute it and check the claim instead of trusting it.
 */

export const COMPOSER_SIGNALS_V1 = 'composer-signals-v1';

/** The exact fields `decision_signal.inputs` is structurally required (plus the one documented
 * passthrough, `sourceTitle`) to hold — migration 0017's CHECKs and the explanation template
 * placeholder whitelist both key off this exact set. Nothing here may name a belief or an
 * inferred interest (AGENTS.md: behavior is evidence, not proof of belief). */
export type ComposerSignalInputs = {
  exposureCount: number;
  lastExposedAt: string | null;
  unread: boolean;
  sourceKey: string;
  recencyDays: number | null;
  sourceRankInSlate: number;
  sourceTitle: string;
};

export type ComposerWeights = { unreadBonus: number; exposurePenalty: number; recencyBonus: number };

export type ComposerPolicy = { version: string; weights: ComposerWeights; slateSize: number; maxPerSource: number };

/** One retrieval-time candidate with only the signals ADR-0028 section 2 permits a ranking to
 * read: exposure count and recency (derived from `exposure`/`ledger`), and the source identity
 * already carried on the asset itself. Nothing here comes from a network call. */
export type SignalCandidate = {
  asset: FeedAsset;
  sourceKey: string;
  sourceTitle: string;
  exposureCount: number;
  lastExposedAtMs: number | null;
};

export type RankedComposerItem = {
  item: FeedAsset & { reason: string };
  rank: number;
  retrievalScore: number;
  explanationKey: string;
  inputs: ComposerSignalInputs;
};

const MS_PER_DAY = 86_400_000;

/**
 * A deterministic, non-cryptographic hash (FNV-1a, 32-bit) used only to break score ties. Tied
 * candidates must resolve to a stable total order (ADR-0028 section 7), but sorting ties on the
 * raw `assetId` string would let whoever mints the lowest lexicographic UUID permanently win every
 * tie — exactly the "permanently crowded out" failure ADR-0025's own interleaving was written to
 * prevent (a fixed low-sorting id would always beat a freshly generated one). Hashing first turns
 * the tie-break into an unbiased, but still fully deterministic and reproducible, ordering: the
 * same `assetId` always hashes to the same value, so the same candidate set still always produces
 * the same slate (the property the determinism tests check), without rewarding a particular id's
 * literal ordinal value.
 */
function tiebreakKey(assetId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < assetId.length; i += 1) {
    hash ^= assetId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The entire scoring function (ADR-0028 section 2): one bounded arithmetic expression over
 * recorded facts, never a provider call. An unread candidate outranks any exposed one by the
 * policy's own declared margin; among exposed candidates, fewer prior exposures and a longer gap
 * since the last one score higher. */
function scoreSignal(weights: ComposerWeights, unread: boolean, exposureCount: number, recencyDays: number | null): number {
  return (unread ? weights.unreadBonus : 0) - weights.exposurePenalty * exposureCount + weights.recencyBonus * (recencyDays ?? 0);
}

function explanationKeyFor(unread: boolean): string {
  return unread ? 'composer_unread' : 'composer_resurfaced';
}

/** Rendering a reason is arithmetic, not authorship (ADR-0028 section 5): substitute the exact
 * recorded `inputs` for that candidate into its registered template. Given only a stored
 * `decision_signal` row (template text + inputs), this reproduces the exact reason a reader once
 * saw — nothing here needs a fresh database read. */
export function renderExplanation(template: string, inputs: ComposerSignalInputs): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = (inputs as unknown as Record<string, unknown>)[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

/**
 * Ranks candidates, enforces diversity and renders each explanation, all in one deterministic
 * pass: same candidates + same kept set + same policy + same templates + same clock reading
 * always produce the same ordering (ADR-0028 section 7). Ties break on `assetId` — a real, stable
 * total order, never insertion order or wall-clock timing.
 *
 * Diversity (section 3) is enforced by construction, not by a post-hoc filter: candidates are
 * walked once in score order and a candidate is skipped (never re-ordered ahead of a lower-scored
 * one) once its source has already filled the policy's `maxPerSource` among already-selected
 * items. Because skipping only ever removes an item from the sequence, the selected slate stays
 * in strict score order — the exact property `decision_signal`'s rank/score consistency trigger
 * requires.
 */
export function rankSignalCandidates(
  candidates: readonly SignalCandidate[],
  keptIds: readonly string[],
  policy: ComposerPolicy,
  templates: Readonly<Record<string, string>>,
  nowMs: number,
): RankedComposerItem[] {
  const kept = new Set(keptIds);
  const scored = candidates
    .filter(c => !kept.has(c.asset.assetId))
    .map(c => {
      const unread = c.exposureCount === 0;
      const recencyDays = unread || c.lastExposedAtMs === null ? null : Math.max(0, Math.floor((nowMs - c.lastExposedAtMs) / MS_PER_DAY));
      return { c, unread, recencyDays, score: scoreSignal(policy.weights, unread, c.exposureCount, recencyDays) };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const hashDiff = tiebreakKey(a.c.asset.assetId) - tiebreakKey(b.c.asset.assetId);
      if (hashDiff !== 0) return hashDiff;
      // Only reached on an actual hash collision (astronomically unlikely for 32 bits over a
      // realistic candidate count): fall back to the raw id so the order stays a strict total
      // order rather than depending on unstable sort implementation behavior.
      return a.c.asset.assetId < b.c.asset.assetId ? -1 : a.c.asset.assetId > b.c.asset.assetId ? 1 : 0;
    });

  const perSource = new Map<string, number>();
  const out: RankedComposerItem[] = [];
  for (const entry of scored) {
    if (out.length >= policy.slateSize) break;
    const used = perSource.get(entry.c.sourceKey) ?? 0;
    if (used >= policy.maxPerSource) continue;
    const explanationKey = explanationKeyFor(entry.unread);
    const template = templates[explanationKey];
    if (template === undefined) throw new Error(`No registered composer_explanation_template for '${explanationKey}'`);
    const inputs: ComposerSignalInputs = {
      exposureCount: entry.c.exposureCount,
      lastExposedAt: entry.unread ? null : new Date(entry.c.lastExposedAtMs!).toISOString(),
      unread: entry.unread,
      sourceKey: entry.c.sourceKey,
      recencyDays: entry.recencyDays,
      sourceRankInSlate: used,
      sourceTitle: entry.c.sourceTitle,
    };
    out.push({
      item: { ...entry.c.asset, reason: renderExplanation(template, inputs) },
      rank: out.length + 1,
      retrievalScore: entry.score,
      explanationKey,
      inputs,
    });
    perSource.set(entry.c.sourceKey, used + 1);
  }
  return out;
}
