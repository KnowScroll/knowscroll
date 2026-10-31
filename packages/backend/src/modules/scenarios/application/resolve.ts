import type { AnnounceThread } from '../../social/public.js';
import type { ReadMadeToOrderProduction } from '../../content/public.js';
import { madeToOrderKey } from '../../content/public.js';
import { answerWaitOver, branchProgress, type ProductionStanding } from '../domain/progress.js';
import type { BranchPoolStore } from './ports.js';

export interface ResolveBranchesPorts {
  readonly store: BranchPoolStore;
  readonly readProduction: ReadMadeToOrderProduction;
  /** Sends the production job of one take outside any transaction (the queue keeps one job per recipe, version and take). */
  readonly sendProduction: (recipe: string, take: number) => Promise<void>;
  readonly announce: AnnounceThread;
  readonly now: () => Date;
}

export interface ResolveSummary {
  readonly bound: number;
  readonly failed: number;
  readonly sent: number;
  /** Short answers whose wait was ended as unavailable. */
  readonly answersEnded: number;
}

/** How many preparing branches one sweep looks at. */
const SWEEP_LIMIT = 50;

/**
 * Settles the branches that are preparing (blueprint §16: "Branch becomes ready: asset binding and
 * branch revision"). For each: an admitted Scroll is bound and the card becomes Ready; a rejected take
 * is followed by the next one; a job that was lost is sent again; and a branch nothing can produce, or
 * that has waited too long, closes as unable to prepare. It reads production's standing, never its
 * research or answers, and makes no model call. Each branch is its own transaction, so one stuck row
 * delays only itself, and a branch another transaction holds is left for the next sweep.
 *
 * It also ends the wait for a short answer that has been in the making too long (D-211): the card then says there
 * will be none, and an answer that arrives later is dropped by the worker.
 *
 * After a change commits it tells the thread's inboxes; the hint is disposable, and the screens poll,
 * so a crash between the two loses an update's speed and nothing else.
 */
export function makeResolveBranches(p: ResolveBranchesPorts) {
  return async function resolveBranches(): Promise<ResolveSummary> {
    let bound = 0;
    let failed = 0;
    let sent = 0;
    let answersEnded = 0;
    for (const branch of await p.store.preparing(SWEEP_LIMIT)) {
      const recipe = madeToOrderKey(branch.nodeId);
      const reading = await p.readProduction(recipe);
      const standing: ProductionStanding = {
        state: reading.state,
        ...(reading.take === undefined ? {} : { take: reading.take }),
        ...(reading.published === undefined
          ? {}
          : { published: { assetRevision: reading.published.assetRevision, title: reading.published.title } }),
      };
      const progress = branchProgress(standing, p.now().getTime() - branch.createdAt.getTime());
      if (progress.kind === 'send') {
        await p.sendProduction(recipe, progress.take);
        sent += 1;
      } else if (progress.kind === 'wait') continue;
      else {
        const settled = await p.store.settle(
          branch.nodeId,
          progress.kind === 'bind'
            ? { kind: 'ready', assetRevision: progress.assetRevision, assetTitle: progress.assetTitle }
            : { kind: 'failed' },
          p.now(),
        );
        if (settled === undefined) continue;
        if (progress.kind === 'bind') bound += 1;
        else failed += 1;
        await p.announce(settled.threadId).catch(() => undefined);
      }
    }
    for (const waiting of await p.store.answersMaking(SWEEP_LIMIT)) {
      if (!answerWaitOver(p.now().getTime() - waiting.createdAt.getTime())) continue;
      const settled = await p.store.settleAnswerUnavailable(waiting.nodeId, p.now());
      if (settled === undefined) continue;
      answersEnded += 1;
      await p.announce(settled.threadId).catch(() => undefined);
    }
    return { bound, failed, sent, answersEnded };
  };
}
