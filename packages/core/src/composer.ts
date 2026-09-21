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

/** Retired without ever being dispatched (#113/ADR-0029 amendment): this row remains in
 * `composer_policy`, immutable forever per migration 0019, but no code path loads it anymore —
 * `packages/core/AGENTS.md` requires "a new policy version, never a code-constant edit to the
 * scoring function" for any ranking change, and the coverage tie-break below is a ranking change.
 * Kept exported only so a reader can still name/reference the historical identifier. */
export const COMPOSER_SIGNALS_V1 = 'composer-signals-v1';

/** ADR-0029 amendment (#113): composer-signals-v1 plus a coverage tie-break (see
 * `rankSignalCandidates`'s comparator below) — the only thing that changed is which candidate wins
 * when the existing signals have said nothing; `scoreSignal` and the declared weights are identical
 * to v1's. Migration 0021 seeds this as its own immutable row rather than mutating v1's. */
export const COMPOSER_SIGNALS_V2 = 'composer-signals-v2';

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
  /** #113/ADR-0029 amendment: recorded exposures for this candidate's whole source in this
   * universe (every asset sharing `sourceKey`, not just this one asset) — the coverage tie-break's
   * own signal, recorded honestly alongside the rank it produced so a later reader can recompute
   * it, not merely trust it. Migration 0021 requires this key structurally. */
  sourceExposureCount: number;
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
  /** #113/ADR-0029 amendment: total recorded exposures in this universe across every asset that
   * shares this candidate's `sourceKey` — bounded to the sourceKeys present in this request's own
   * candidate set (`packages/db/src/composer-signals.ts`), never every source the universe has
   * ever seen. This is the coverage tie-break's only new input. */
  sourceExposureCount: number;
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
 * always produce the same ordering (ADR-0028 section 7). Ties break first on coverage, then on
 * `assetId` — both real, stable total orders, never insertion order or wall-clock timing.
 *
 * #113/ADR-0029 amendment — the coverage tie-break: `unreadBonus` makes every never-exposed
 * candidate score identically, so in a library with more unread assets than slate slots, *something*
 * has to decide who wins among ties every single time. Breaking that purely on a hash of `assetId`
 * (composer-signals-v1) is deterministic but carries no information about whether a *source* has
 * ever been offered — an abundant source with many low-hashing assets can keep winning forever
 * while a source with few assets and an unlucky hash is never offered at all, no matter how many
 * decisions are made. Comparing `sourceExposureCount` first (fewer recorded exposures for that
 * candidate's whole source wins) fixes this without touching `unreadBonus`/`exposurePenalty`/
 * `recencyBonus` or `maxPerSource` at all: once a source's candidates get exposed, that source's
 * own count rises, so a source that has never been offered always outranks one that has, among
 * candidates the score alone cannot separate. This is what makes "every source in the library is
 * eventually offered" true: offering a source (and a reader then encountering what was offered) is
 * the one thing that can ever lower that source's own tie-break priority again. A source that could
 * never be offered could never become a world (ADR-0028), never join a system, and never appear in
 * an explanation — the ranking would be quietly deciding that part of the library does not exist.
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
      // Coverage tie-break (#113/ADR-0029 amendment): among candidates the score cannot separate,
      // the source with fewer recorded exposures in this universe wins — never a code-constant
      // preference for a particular source, only what this universe's own history already records.
      if (a.c.sourceExposureCount !== b.c.sourceExposureCount) return a.c.sourceExposureCount - b.c.sourceExposureCount;
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
      sourceExposureCount: entry.c.sourceExposureCount,
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
