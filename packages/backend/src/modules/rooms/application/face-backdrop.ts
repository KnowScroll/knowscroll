import { conceptLabel } from '../../content/public.js';
import type { ImageOutcome, ImagePort } from '../../../reasoning/public.js';
import { BACKDROP_PRICING, BACKDROP_SPEND_CAP_MICRO_USD, decideSpend } from '../domain/backdrop-spend.js';
import { backdropPrompt } from './backdrop-prompt.js';
import type {
  AttemptRow,
  BackdropMedia,
  BackdropRow,
  Decision,
  DecisionOutcome,
  FaceStore,
  Settlement,
} from './face-ports.js';
import { kitToShow } from './kit.js';

/** The price the estimate comes from, and the cap. Tests inject a smaller cap; production uses the constants. */
export interface BackdropMoney {
  readonly microUsdPerImage: number;
  readonly priceSource: string;
  readonly priceCheckedOn: string;
  readonly capMicroUsd: number;
}

export const BACKDROP_MONEY: BackdropMoney = {
  microUsdPerImage: BACKDROP_PRICING.microUsdPerImage,
  priceSource: BACKDROP_PRICING.sourceUrl,
  priceCheckedOn: BACKDROP_PRICING.checkedOn,
  capMicroUsd: BACKDROP_SPEND_CAP_MICRO_USD,
};

export interface FaceBackdropPorts {
  readonly store: FaceStore;
  /** Where pictures are kept; absent where no media root is configured. */
  readonly media: BackdropMedia | undefined;
  /** The image provider; absent where none is configured. */
  readonly image: ImagePort | undefined;
  readonly money: BackdropMoney;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly sha256: (text: string) => string;
}

/** Why a picture was not asked for. `cap` is the dollar rule; the others keep an unknown or waiting result from piling up. */
export type RefusalReason = 'cap' | 'unresolved_attempt' | 'review_pending' | 'not_configured';

export interface SpendFigures {
  readonly recordedMicroUsd: number;
  readonly estimateMicroUsd: number;
  readonly capMicroUsd: number;
  readonly remainingAfterMicroUsd: number;
}

export type GenerateBackdropResult =
  | { readonly kind: 'unknown_room' }
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly figures?: SpendFigures }
  | {
      readonly kind: 'dry_run';
      readonly slug: string;
      readonly prompt: string;
      readonly kitSource: 'approved' | 'default';
      readonly figures: SpendFigures;
      /** What a real run would be refused for right now, if anything. */
      readonly wouldRefuse: RefusalReason | undefined;
      readonly priceSource: string;
      readonly priceCheckedOn: string;
    }
  | {
      readonly kind: 'made';
      readonly attemptId: string;
      readonly backdropId: string;
      readonly chargeMicroUsd: number;
      readonly mime: string;
      readonly sizeBytes: number;
    }
  /** No usable picture. `unknown` was charged and will not be sent again; the rest say what the charge is. */
  | {
      readonly kind: 'not_made';
      readonly attemptId: string;
      readonly state: 'failed' | 'not_sent' | 'unknown' | 'succeeded';
      readonly code: string;
      readonly chargeMicroUsd: number;
    };

export interface SpendReport extends SpendFigures {
  /** What may still be spent before the cap. */
  readonly remainingMicroUsd: number;
  readonly imagesLeft: number;
  readonly attempts: number;
  readonly unresolved: readonly AttemptRow[];
  readonly priceSource: string;
  readonly priceCheckedOn: string;
}

export interface FaceBackdropOperator {
  generate(input: { slug: string; dryRun: boolean; signal: AbortSignal; by: string }): Promise<GenerateBackdropResult>;
  list(limit: number): Promise<readonly BackdropRow[]>;
  review(input: {
    backdropId: string;
    decision: Decision;
    by: string;
  }): Promise<{ kind: DecisionOutcome | 'missing_file' }>;
  spend(): Promise<SpendReport>;
  /** The operator has read the provider's own record of an unknown attempt: it was charged or it was not. */
  reconcile(input: { attemptId: string; charged: boolean; reason: string; by: string }): Promise<{ kind: string }>;
  /** The operator gives up on an unknown attempt: it stays charged. */
  writeOff(input: { attemptId: string; reason: string; by: string }): Promise<{ kind: string }>;
}

/** Slack on top of the provider's own deadline before a dispatched attempt is taken for unknown. */
const STALE_MARGIN_MS = 120_000;
/** The longest deadline any configuration allows, for a process that has no image provider to ask. */
const STALE_DEADLINE_FALLBACK_MS = 300_000;

/**
 * The operator's controls over painted room backdrops (D-166). Rules, in order of importance:
 *
 * 1. **The $1 cap is checked under a lock, before the attempt exists.** The attempt is recorded (dispatched, charged its
 *    estimate) in the same transaction that took the lock and read the total, so two operators at once cannot both pass
 *    the cap. An attempt that would pass it is refused and recorded nowhere.
 * 2. **One attempt, once.** The intent is recorded before the request leaves; no step sends a request twice. An outcome
 *    that may have been processed (a timeout, a reset, a success with no image, a crash after dispatch) is `unknown`,
 *    keeps its charge, blocks further attempts for that room, and is settled only by an operator who has read the
 *    provider's own record.
 * 3. **Nothing waits in a transaction.** The provider call and the file write are outside every transaction.
 * 4. **A picture is never shown unreviewed.** It is stored as pending; an operator approves it.
 *
 * The prompt comes from the room's library topic and its kit only (no member text).
 */
export function makeFaceBackdropOperator(p: FaceBackdropPorts): FaceBackdropOperator {
  const { money } = p;
  const staleAfterMs = (p.image?.requestTimeoutMs ?? STALE_DEADLINE_FALLBACK_MS) + STALE_MARGIN_MS;

  async function sweepStale(): Promise<void> {
    const at = p.now();
    await p.store.markStaleUnknown(new Date(at.getTime() - staleAfterMs), at);
  }

  function figures(recordedMicroUsd: number): SpendFigures {
    return {
      recordedMicroUsd,
      estimateMicroUsd: money.microUsdPerImage,
      capMicroUsd: money.capMicroUsd,
      remainingAfterMicroUsd: money.capMicroUsd - recordedMicroUsd - money.microUsdPerImage,
    };
  }

  /** Step 1, in one transaction under the spend lock: decide, and record the attempt as dispatched. */
  async function reserve(slug: string, dryRun: boolean, by: string) {
    return p.store.inLedgerTransaction(async (ledger) => {
      const state = await ledger.roomState(slug);
      if (state === undefined) return { kind: 'unknown_room' } as const;
      const recorded = await ledger.recordedSpend();
      const kit = kitToShow(state.approvedKit?.kit, state.room.roomId);
      const prompt = backdropPrompt({ topicLabel: conceptLabel(state.room.topic.id), kit });
      const spend = decideSpend(recorded, money.microUsdPerImage, money.capMicroUsd);
      const refusal: RefusalReason | undefined =
        state.unresolved > 0
          ? 'unresolved_attempt'
          : state.pendingBackdrops > 0
            ? 'review_pending'
            : spend.kind === 'refused'
              ? 'cap'
              : undefined;
      const numbers = figures(recorded);
      if (dryRun)
        return {
          kind: 'dry_run',
          prompt,
          kitSource: state.approvedKit === undefined ? 'default' : 'approved',
          figures: numbers,
          wouldRefuse: refusal,
        } as const;
      if (refusal !== undefined) return { kind: 'refused', reason: refusal, figures: numbers } as const;
      const attemptId = p.newId();
      await ledger.reserve({
        attemptId,
        roomId: state.room.roomId,
        kitRevision: state.approvedKit?.revision,
        model: p.image?.model ?? 'unconfigured',
        promptSha256: p.sha256(prompt),
        estimateMicroUsd: money.microUsdPerImage,
        priceSource: money.priceSource,
        priceCheckedOn: money.priceCheckedOn,
        requestedBy: by,
        at: p.now(),
      });
      return { kind: 'reserved', attemptId, prompt } as const;
    });
  }

  /** Step 3: what the request came to becomes the attempt's settlement, storing the picture if there is one. */
  async function settlementOf(outcome: ImageOutcome, media: BackdropMedia): Promise<Settlement> {
    const at = p.now();
    switch (outcome.kind) {
      case 'rejected':
        return { state: 'failed', code: outcome.code, at };
      case 'not_sent':
        return { state: 'not_sent', code: outcome.code, at };
      case 'unknown':
        return { state: 'unknown', code: outcome.code, at };
      case 'unusable':
        return { state: 'succeeded', code: outcome.code, at };
      case 'image':
        try {
          const stored = await media.put(outcome.bytes, outcome.mime);
          return {
            state: 'succeeded',
            code: undefined,
            at,
            backdrop: {
              backdropId: p.newId(),
              mediaKey: stored.key,
              sha256: stored.sha256,
              sizeBytes: stored.size,
              mime: outcome.mime,
            },
          };
        } catch {
          // The picture was made and paid for; it cannot be kept, so the attempt stays charged with no picture.
          return { state: 'succeeded', code: 'STORE_FAILED', at };
        }
    }
  }

  return {
    async generate({ slug, dryRun, signal, by }) {
      await sweepStale();
      const { image, media } = p;
      if (!dryRun && (image === undefined || media === undefined)) return { kind: 'refused', reason: 'not_configured' };
      const reserved = await reserve(slug, dryRun, by);
      if (reserved.kind === 'unknown_room') return { kind: 'unknown_room' };
      if (reserved.kind === 'refused') return reserved;
      if (reserved.kind === 'dry_run')
        return {
          kind: 'dry_run',
          slug,
          prompt: reserved.prompt,
          kitSource: reserved.kitSource,
          figures: reserved.figures,
          wouldRefuse: reserved.wouldRefuse,
          priceSource: money.priceSource,
          priceCheckedOn: money.priceCheckedOn,
        };
      if (image === undefined || media === undefined) return { kind: 'refused', reason: 'not_configured' };
      const outcome = await image.generate({ prompt: reserved.prompt }, signal);
      const settlement = await settlementOf(outcome, media);
      const settled = await p.store.settleAttempt(reserved.attemptId, settlement);
      // Another process took this attempt for unknown while the request ran; it stays charged and is not sent again.
      if (!settled)
        return {
          kind: 'not_made',
          attemptId: reserved.attemptId,
          state: 'unknown',
          code: 'SETTLEMENT_LOST',
          chargeMicroUsd: money.microUsdPerImage,
        };
      const chargeMicroUsd =
        settlement.state === 'failed' || settlement.state === 'not_sent' ? 0 : money.microUsdPerImage;
      if (settlement.state === 'succeeded' && settlement.backdrop !== undefined)
        return {
          kind: 'made',
          attemptId: reserved.attemptId,
          backdropId: settlement.backdrop.backdropId,
          chargeMicroUsd,
          mime: settlement.backdrop.mime,
          sizeBytes: settlement.backdrop.sizeBytes,
        };
      return {
        kind: 'not_made',
        attemptId: reserved.attemptId,
        state: settlement.state,
        code: settlement.code ?? 'NO_CODE',
        chargeMicroUsd,
      };
    },

    list: (limit) => p.store.listBackdrops(limit),

    async review({ backdropId, decision, by }) {
      const row = await p.store.backdrop(backdropId);
      if (row === undefined) return { kind: 'unknown' };
      if (decision === 'approved' && !(await (p.media?.has(row.mediaKey, row.sizeBytes) ?? Promise.resolve(false))))
        return { kind: 'missing_file' };
      return { kind: await p.store.decideBackdrop({ backdropId, decision, by, at: p.now() }) };
    },

    async spend() {
      await sweepStale();
      const state = await p.store.spend(50);
      return {
        ...figures(state.recordedMicroUsd),
        remainingMicroUsd: money.capMicroUsd - state.recordedMicroUsd,
        imagesLeft: Math.max(0, Math.floor((money.capMicroUsd - state.recordedMicroUsd) / money.microUsdPerImage)),
        attempts: state.attempts,
        unresolved: state.unresolved,
        priceSource: money.priceSource,
        priceCheckedOn: money.priceCheckedOn,
      };
    },

    async reconcile({ attemptId, charged, reason, by }) {
      const kind = await p.store.resolveUnknown({
        attemptId,
        resolution: 'reconciled',
        charged,
        reason,
        by,
        at: p.now(),
      });
      return { kind };
    },

    async writeOff({ attemptId, reason, by }) {
      const kind = await p.store.resolveUnknown({ attemptId, resolution: 'written_off', reason, by, at: p.now() });
      return { kind };
    },
  };
}
