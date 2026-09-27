/**
 * ADR-0044 — a Relic's state, derived when read: pure over the facts the database gathers for each
 * kind. Corrected beats doubted, which beats current; nothing here hides a correction.
 */
import { RELIC_CURSOR_PATTERN } from '../../contracts/src/relics.ts';

export type RelicState = 'current' | 'corrected' | 'doubted';

/** What is known about one Relic when it is read (ADR-0044 §2). */
export type RelicFacts =
  /** The bridge now, and whether the reader marked it "seems wrong" (ADR-0031 feedback). */
  | { kind: 'connection'; bridgeStatus: 'admitted' | 'revoked' | 'superseded'; seemsWrong: boolean }
  /** Whether a source correction changed the place after it was kept; whether the reader set it aside. */
  | { kind: 'place'; correctedSinceKept: boolean; setAside: boolean }
  /** The Scroll's revision when kept and now; how many claims it was kept on have since lost their support. */
  | { kind: 'passage' | 'answer'; keptRevision: number; currentRevision: number; unsupportedClaims: number; seemsWrong: boolean };

function corrected(f: RelicFacts): boolean {
  switch (f.kind) {
    case 'connection': return f.bridgeStatus !== 'admitted';
    case 'place': return f.correctedSinceKept;
    default: return f.currentRevision !== f.keptRevision || f.unsupportedClaims > 0;
  }
}

function doubted(f: RelicFacts): boolean {
  return f.kind === 'place' ? f.setAside : f.seemsWrong;
}

export function relicState(f: RelicFacts): RelicState {
  if (corrected(f)) return 'corrected';
  return doubted(f) ? 'doubted' : 'current';
}

/** The Relic list pages newest first by keep time, then id (ADR-0044 §7, M8). The cursor carries the
 * keep time at the database's microsecond precision, so equal milliseconds never repeat or skip. */
export function relicCursor(keptAt: string, relicId: string): string {
  return `${keptAt}|${relicId}`;
}

export function parseRelicCursor(cursor: string): { keptAt: string; relicId: string } | null {
  const m = RELIC_CURSOR_PATTERN.exec(cursor);
  return m ? { keptAt: m[1]!, relicId: m[2]! } : null;
}
