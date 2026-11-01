import type { ContentRef, ScrollAskFacts } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { ASK_KICKER, askBrief } from '../domain/ask-order.js';
import type { AskOrderLink, SupplyPorts } from './ports.js';

const UTC_DAY_MS = 86_400_000;

export type AskCommission =
  /** The order is recorded and its production job is sent in the caller's transaction. */
  | { readonly kind: 'commissioned'; readonly order: AskOrderLink }
  /** `budget_unavailable`: a day's cap is full (or ask orders are off). `could_not_prepare`: nothing to research the answer from. */
  | { readonly kind: 'unavailable'; readonly reason: 'budget_unavailable' | 'could_not_prepare' };

/** What one ask order is made from: the Scroll and stop the person asked from, and their words. */
export interface AskOrderInput {
  readonly source: ContentRef;
  readonly facts: ScrollAskFacts;
  readonly question: string;
}

/**
 * Quartermaster's Create for a person's question (blueprint §11; D-218): a short Scroll made for this person alone,
 * through the same made-to-order path as a thread's branch (D-049). The brief is built by code from the question, the
 * title of the Scroll and the words of the stop; the research pages are chosen by code from that Scroll's own
 * provenance, never by the model or the person; the Scroll is attributed to no topic and is open to its asker only.
 * Two caps bound the spend, counted from the ledger and from the person's own asks: the world's UTC day
 * (`KS_SUPPLY_ASK_DAILY_CAP`, 0 turns ask orders off) and the person's (`KS_SUPPLY_ASK_PERSON_DAILY_CAP`).
 *
 * Authority: runs inside the caller's open personal scope, after the personal root and Content's locks. The
 * commissioning lock follows and is last in the lock order. No model call or network wait happens here: production
 * runs later in a worker. Retrying the same request makes no second order: the caller makes the order once, when the
 * request leaves `matching` or is created.
 */
export async function commissionAskOrder(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  input: AskOrderInput,
): Promise<AskCommission> {
  await p.store.lockCommissioning(scope);
  const startOfDay = new Date(Math.floor(p.now().getTime() / UTC_DAY_MS) * UTC_DAY_MS);
  if ((await p.askLedger.countSince(scope, startOfDay)) >= p.askCaps.perDay)
    return { kind: 'unavailable', reason: 'budget_unavailable' };
  if ((await p.store.countAskOrdersSince(scope, startOfDay)) >= p.askCaps.perPersonPerDay)
    return { kind: 'unavailable', reason: 'budget_unavailable' };
  const pages = await p.readSourcePages(scope, input.source);
  if (pages.length === 0) return { kind: 'unavailable', reason: 'could_not_prepare' };
  const order = { orderId: p.newId(), assetId: p.newId() };
  const { recipe } = await p.recordOrder(scope, {
    ...order,
    mode: 'question',
    brief: askBrief({ question: input.question, subjectTitle: input.facts.title, stopText: input.facts.stopText }),
    pages,
    kicker: ASK_KICKER,
    framing: { kind: 'factual' },
  });
  await p.askLedger.insert(scope, order.orderId);
  await p.enqueueAnswerProduction(scope, recipe, 1);
  return { kind: 'commissioned', order };
}
