/**
 * #131 — attention accounts (`attention-v1`, ADR-0032 §1). Pure: evidence in, per-concept accounts
 * out. An account is a routing aid for the Composer and Cartographer, never a statement about the
 * person: watching contributes a little, voluntary acts contribute more, nothing here can say why.
 *
 * Episode = one exposure plus the voluntary acts it caused (keep, branch, ask). Weight = base for
 * being shown + a bonus per distinct voluntary kind (capped) + a separated-return bonus. Credit
 * follows the encounter's annotated concepts by role. Mass decays with a half-life; counts do not.
 */
export const ATTENTION_POLICY_V1 = 'attention-v1';

export type MarkKind = 'keep' | 'branch' | 'ask';
export type ConceptRole = 'primary' | 'secondary' | 'mentioned';

export interface AttentionPolicy {
  version: string;
  halfLifeDays: number;
  baseWeight: number;
  voluntaryWeight: number;
  maxVoluntaryKinds: number;
  returnBonus: number;
  returnGapHours: number;
  roleWeights: Record<ConceptRole, number>;
  anchored: { episodes: number; daysActive: number; voluntary: number; sourceFamilies: number; mass: number };
  dormant: { mass: number; idleDays: number };
}

/** Bench values (target 06 §3–§5); they move only as a new policy version. */
export const ATTENTION_V1: AttentionPolicy = {
  version: ATTENTION_POLICY_V1,
  halfLifeDays: 21,
  baseWeight: 0.5,
  voluntaryWeight: 1.5,
  maxVoluntaryKinds: 3,
  returnBonus: 2,
  returnGapHours: 4,
  roleWeights: { primary: 1, secondary: 0.5, mentioned: 0.2 },
  anchored: { episodes: 3, daysActive: 2, voluntary: 2, sourceFamilies: 2, mass: 4 },
  dormant: { mass: 1, idleDays: 30 },
};

export interface EpisodeEvidence {
  exposureId: string;
  atMs: number;
  assetId: string;
  concepts: readonly { code: string; role: ConceptRole }[];
  /** The evidence family of the encounter's source, when the substrate knows it. */
  familyKey: string | null;
  /** True when a ranking decision offered it; false for an explicit request (a branch). */
  systemOffered: boolean;
  marks: readonly { eventId: string; kind: MarkKind; atMs: number }[];
}

export interface NegativeEvidence { ref: string; atMs: number; concepts: readonly string[] }

export type AccountState = 'seen' | 'anchored' | 'dormant';

export interface AttentionAccount {
  concept: string;
  /** Decayed to `massAtMs`. */
  mass: number;
  massAtMs: number;
  episodes: number;
  voluntary: number;
  markKinds: Record<MarkKind, number>;
  returns: number;
  daysActive: number;
  spanDays: number;
  sourceFamilies: number;
  /** Fraction of episodes a ranking decision offered (humility, never a discount). */
  exposureShare: number;
  negatives: number;
  firstAtMs: number;
  lastAtMs: number;
  lastMarkAtMs: number | null;
  state: AccountState;
  evidence: { episodeIds: string[]; markIds: string[]; negativeIds: string[] };
}

const DAY = 86_400_000;
const day = (ms: number) => Math.floor(ms / DAY);

export function decayedMass(mass: number, fromMs: number, toMs: number, halfLifeDays: number): number {
  return mass * Math.pow(2, -Math.max(0, toMs - fromMs) / (halfLifeDays * DAY));
}

export function computeAttentionAccounts(
  episodes: readonly EpisodeEvidence[],
  negatives: readonly NegativeEvidence[],
  nowMs: number,
  policy: AttentionPolicy = ATTENTION_V1,
): Map<string, AttentionAccount> {
  type Working = AttentionAccount & { markDays: Set<number>; families: Set<string>; offered: number; lastEpisodeAtMs: number | null };
  const accounts = new Map<string, Working>();
  const ordered = [...episodes].sort((a, b) => a.atMs - b.atMs || (a.exposureId < b.exposureId ? -1 : a.exposureId > b.exposureId ? 1 : 0));

  for (const episode of ordered) {
    const kinds = new Set(episode.marks.map(m => m.kind));
    const voluntary = episode.marks.length > 0;
    for (const link of episode.concepts) {
      const credit = policy.roleWeights[link.role];
      if (!credit) continue;
      let a = accounts.get(link.code);
      if (!a) {
        a = {
          concept: link.code, mass: 0, massAtMs: nowMs, episodes: 0, voluntary: 0, markKinds: { keep: 0, branch: 0, ask: 0 },
          returns: 0, daysActive: 0, spanDays: 0, sourceFamilies: 0, exposureShare: 0, negatives: 0,
          firstAtMs: episode.atMs, lastAtMs: episode.atMs, lastMarkAtMs: null, state: 'seen',
          evidence: { episodeIds: [], markIds: [], negativeIds: [] },
          markDays: new Set(), families: new Set(), offered: 0, lastEpisodeAtMs: null,
        };
        accounts.set(link.code, a);
      }
      let weight = policy.baseWeight + policy.voluntaryWeight * Math.min(kinds.size, policy.maxVoluntaryKinds);
      const separated = a.lastEpisodeAtMs !== null && episode.atMs - a.lastEpisodeAtMs >= policy.returnGapHours * 3_600_000;
      if (voluntary && separated) { weight += policy.returnBonus; a.returns += 1; }
      a.mass += credit * weight * Math.pow(2, -Math.max(0, nowMs - episode.atMs) / (policy.halfLifeDays * DAY));
      a.episodes += 1;
      if (episode.systemOffered) a.offered += 1;
      a.lastEpisodeAtMs = episode.atMs;
      a.lastAtMs = Math.max(a.lastAtMs, episode.atMs);
      a.evidence.episodeIds.push(episode.exposureId);
      for (const mark of episode.marks) {
        a.voluntary += 1;
        a.markKinds[mark.kind] += 1;
        a.markDays.add(day(mark.atMs));
        a.lastMarkAtMs = Math.max(a.lastMarkAtMs ?? 0, mark.atMs);
        a.evidence.markIds.push(mark.eventId);
      }
      if (voluntary && episode.familyKey) a.families.add(episode.familyKey);
    }
  }
  for (const negative of negatives) {
    for (const code of negative.concepts) {
      const a = accounts.get(code);
      if (!a) continue;
      a.negatives += 1;
      a.evidence.negativeIds.push(negative.ref);
    }
  }

  const out = new Map<string, AttentionAccount>();
  for (const [code, a] of accounts) {
    const markDays = [...a.markDays].sort((x, y) => x - y);
    const account: AttentionAccount = {
      concept: a.concept, mass: round(a.mass), massAtMs: nowMs, episodes: a.episodes, voluntary: a.voluntary,
      markKinds: a.markKinds, returns: a.returns, daysActive: markDays.length,
      spanDays: markDays.length ? markDays[markDays.length - 1]! - markDays[0]! : 0,
      sourceFamilies: a.families.size, exposureShare: a.episodes ? round(a.offered / a.episodes) : 0,
      negatives: a.negatives, firstAtMs: a.firstAtMs, lastAtMs: a.lastAtMs, lastMarkAtMs: a.lastMarkAtMs,
      state: 'seen', evidence: a.evidence,
    };
    account.state = stateOf(account, nowMs, policy);
    out.set(code, account);
  }
  return out;
}

/** State lines are routing hints. Anchoring needs acts on separate days from separate sources;
 * watching can never cross it. Dormancy is an anchored-shaped history whose mass has faded. */
export function stateOf(a: Omit<AttentionAccount, 'state'>, nowMs: number, policy: AttentionPolicy = ATTENTION_V1): AccountState {
  const t = policy.anchored;
  const shaped = a.episodes >= t.episodes && a.daysActive >= t.daysActive && a.voluntary >= t.voluntary && a.sourceFamilies >= t.sourceFamilies;
  if (!shaped) return 'seen';
  if (a.mass >= t.mass) return 'anchored';
  const idle = a.lastMarkAtMs === null ? Infinity : (nowMs - a.lastMarkAtMs) / DAY;
  return a.mass < policy.dormant.mass && idle >= policy.dormant.idleDays ? 'dormant' : 'seen';
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
