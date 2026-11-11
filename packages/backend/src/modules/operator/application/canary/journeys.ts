import type { EncounterOffer } from '@knowscroll/contracts';
import type { PersonaPlan } from '../../domain/canary/personas.js';
import type { Pacer } from './ports.js';
import type { ReaderSession } from './session.js';

/** The formats a reader stays in while moving: a subject move keeps the format of what it is on. */
function formatOf(offer: EncounterOffer): 'reel' | 'scroll' {
  return offer.metadata.kind;
}

/** A move that leaves the subject, in the format of the offer in front of the reader. */
function moveOn(session: ReaderSession, from: EncounterOffer, format: 'reel' | 'scroll' = formatOf(from)) {
  return session.step('vertical', { mode: 'vertical', direction: 'next', format });
}

/** The next part of the series the reader is in; when there is none, a move to another subject. */
async function nextPartOrSubject(session: ReaderSession, from: EncounterOffer): Promise<EncounterOffer | undefined> {
  return (await session.step('series', { mode: 'series', direction: 'next' })) ?? (await moveOn(session, from));
}

/**
 * Reads what the system offers first, then takes whatever it offers next, up to the persona's encounters. For a
 * new account it proves something is offered and recorded; for a reader of many Scrolls it proves nothing repeats.
 */
async function readOnward(session: ReaderSession, plan: PersonaPlan): Promise<void> {
  let offer = await session.open();
  for (let met = 0; offer !== undefined && met < plan.encounters; met += 1) {
    if (!(await session.meet(offer, 'read'))) return;
    offer = met + 1 < plan.encounters ? await moveOn(session, offer) : undefined;
  }
}

/** Follows a series part by part, as long as the series goes on, so the rules entitle its system and planet. */
async function deepReader(session: ReaderSession, plan: PersonaPlan, parts = plan.encounters): Promise<void> {
  let offer = await session.open();
  for (let met = 0; offer !== undefined && met < parts; met += 1) {
    if (!(await session.meet(offer, 'read'))) return;
    offer = met + 1 < parts ? await nextPartOrSubject(session, offer) : undefined;
  }
}

/** Reads a series, waits for the place it forms, then opens one of its regions on purpose and reads that. */
async function topicSwitcher(session: ReaderSession, plan: PersonaPlan, waitMs: number, pacer: Pacer): Promise<void> {
  await deepReader(session, plan, 3);
  await session.settleEvidence(pacer.nowMs() + waitMs);
  await session.settleFormation(pacer.nowMs() + waitMs);
  const region = await session.openRegion();
  if (region !== undefined) await session.meet(region, 'read');
}

/** Prefers Reels: opens the Reel of what it is offered when there is one, and keeps moving in Reels. */
async function reelWatcher(session: ReaderSession, plan: PersonaPlan): Promise<void> {
  let offer = await session.open();
  if (offer !== undefined && formatOf(offer) === 'scroll') {
    const reelReady = offer.variants.some((variant) => variant.kind === 'reel' && variant.status === 'ready');
    if (!(await session.meet(offer, 'glance'))) return;
    offer = reelReady
      ? ((await session.step('variant', { mode: 'variant', to: 'reel' })) ?? (await moveOn(session, offer, 'reel')))
      : await moveOn(session, offer, 'reel');
  }
  for (let met = 0; offer !== undefined && met < plan.encounters; met += 1) {
    if (!(await session.meet(offer, 'read'))) return;
    offer = met + 1 < plan.encounters ? await moveOn(session, offer, 'reel') : undefined;
  }
}

/**
 * One persona's whole journey: its moves, then the bounded wait for its readings to be projected and for the places
 * its reading entitles. `waitMs` bounds each of those waits; a persona that has nothing due waits for neither.
 */
export async function runPersonaJourney(
  session: ReaderSession,
  plan: PersonaPlan,
  options: { readonly waitMs: number; readonly pacer: Pacer },
): Promise<void> {
  if (!(await session.begin())) return;
  switch (plan.id) {
    case 'cold-start':
    case 'many-reads':
      await readOnward(session, plan);
      break;
    case 'deep-reader':
      await deepReader(session, plan);
      break;
    case 'topic-switcher':
      await topicSwitcher(session, plan, options.waitMs, options.pacer);
      break;
    case 'reel-watcher':
      await reelWatcher(session, plan);
      break;
  }
  await session.settleEvidence(options.pacer.nowMs() + options.waitMs);
  await session.settleFormation(options.pacer.nowMs() + options.waitMs);
}
