import type { CatalogueSnapshot } from '../../content/public.js';
import type { CheckPersonalAccountDisposable } from '../../identity/public.js';
import { gapIdentity, isCatalogueTarget, type CatalogueTopic } from '../domain/gaps.js';
import type { GapMarkStore, GapSignalInput, RecordGapSignals } from './gap-ports.js';

/**
 * The planets of the catalogue and the facets of each, as the loop checks every name against them (exact membership). It includes the
 * planets that are not servable yet: the loop is what gives them the supply that makes them so.
 */
export const catalogueTopics = (catalogue: CatalogueSnapshot): readonly CatalogueTopic[] =>
  catalogue.allTopics().map((concept) => ({
    id: concept.id,
    facets: concept.facets.map((facet) => facet.id),
  }));

/** The most signals one call records: a decision offers three explanations, and a person gets one count a day for each gap anyway. */
export const MAX_SIGNALS_PER_CALL = 3;

/** The UTC day of a moment, `2026-11-11`: the day a signal is counted on. */
export const utcDay = (when: Date): string => when.toISOString().slice(0, 10);

/**
 * The signals worth recording from a call: those that name a planet (and facet) of the catalogue, each gap once, at most
 * {@link MAX_SIGNALS_PER_CALL}. A name the catalogue lacks is dropped, so no free text, label or model string can reach a gap.
 */
export function recordableSignals(
  catalogue: readonly CatalogueTopic[],
  signals: readonly GapSignalInput[],
): readonly GapSignalInput[] {
  const seen = new Set<string>();
  const kept: GapSignalInput[] = [];
  for (const signal of signals) {
    if (!isCatalogueTarget(catalogue, signal)) continue;
    const identity = gapIdentity('demand', signal);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push({
      source: signal.source,
      planet: signal.planet,
      ...(signal.facet === undefined ? {} : { facet: signal.facet }),
    });
    if (kept.length === MAX_SIGNALS_PER_CALL) break;
  }
  return kept;
}

export interface RecordGapSignalsPorts {
  /** `KS_SUPPLY_GROWTH_ENABLED`: off, and nothing is recorded. */
  readonly enabled: boolean;
  readonly marks: GapMarkStore;
  /** Whether the person's account is a disposable test account: such an account never feeds shared supply (identity's public port). */
  readonly isDisposable: CheckPersonalAccountDisposable;
  readonly now: () => Date;
  /** The planets and facets every named planet and facet is checked against (exact membership): the topic catalogue's, from `catalogueTopics`. */
  readonly catalogue: () => Promise<readonly CatalogueTopic[]>;
}

/**
 * Records where the system noticed that content runs out (#674, D-414): a Composer decision that fell to the last resort or offered
 * the last explanation of a topic, a planned demand or an ask that found no recipe left. Each is the person's own mark for the UTC day
 * (`supply.gap_signal_marks`, at most one for each planet and facet a day) inside the transaction that already knows it. It locks no
 * shared row: the scan counts the marks into `supply.gap_signals` later. Counts only: never the ask's words, never a title.
 * Where the loop is off, or the account is a disposable test account, it writes nothing.
 */
export function makeRecordGapSignals(ports: RecordGapSignalsPorts): RecordGapSignals {
  return async (scope, signals) => {
    if (!ports.enabled || signals.length === 0) return;
    const kept = recordableSignals(await ports.catalogue(), signals);
    if (kept.length === 0) return;
    // A disposable test account's reading is never shared supply's business: no mark, so no counter, no gap and no recipe.
    if (await ports.isDisposable(scope)) return;
    await ports.marks.mark(scope, utcDay(ports.now()), kept);
  };
}
