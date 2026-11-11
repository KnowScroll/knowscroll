import { mixOf, type PersonaSpec } from './persona.js';
import type { OfferView } from './model.js';
import type { Library, LibraryUnit } from './library.js';

/** A reader who likes text opens the Scroll when "Somewhere new" offers a choice, and stays in Scrolls. */
const preferScroll = (offers: readonly OfferView[]) => offers.find((offer) => offer.kind === 'scroll') ?? offers[0]!;

/**
 * The lab's synthetic readers. Each one is a pattern of attention, not a model of a real person: the
 * mixes below are bench values chosen to exercise a behaviour (a deep reader qualifies, a skimmer
 * never does), and a fixture passing says nothing about how people really read.
 */

/** Has no history and takes what comes: some reads, some skims, some half-reads. */
export const coldStartExplorer: PersonaSpec = {
  id: 'cold-start-explorer',
  title: 'Cold-start explorer: no history, takes what comes',
  encounters: (config) => config.sessions.typical,
  reading: (_offer, { rng }) => mixOf(rng, { read: 0.55, partial: 0.2, skim: 0.25 }),
};

/** Reads one topic in full and skims the rest, so evidence concentrates and a planet can form. */
export const focusedDeepReader: PersonaSpec = {
  id: 'focused-deep-reader',
  title: 'Focused deep reader: reads one topic in full, skims the rest',
  choose: preferScroll,
  encounters: (config) => config.sessions.typical,
  reading: (offer, { rng, memory }) => {
    memory.focusTopic ??= offer.topicId;
    return offer.topicId === memory.focusTopic ? 'read' : mixOf(rng, { skim: 0.7, partial: 0.3 });
  },
};

/**
 * Taps "Somewhere new" again and again, opening an offer about a topic it has not seen (and tapping again when none of
 * the choices is), and stays on none for more than a few seconds: breadth without depth. It never qualifies, but it
 * touches every topic it meets, and it goes on until it has met all of them.
 */
export const broadSkimmer: PersonaSpec = {
  id: 'broad-skimmer',
  title: 'Broad skimmer: hops to somewhere new, quick opens that do not qualify',
  encounters: (config) => config.sessions.typical * 3,
  maxBrowses: 6,
  // It keeps hopping a few encounters past the last new topic, as someone who has just run through everything would.
  until: ({ memory }) => (memory.afterEveryTopic ?? 0) >= 5,
  move: () => 'discover',
  choose: (offers, { memory, library }) =>
    memory.touchedTopics.size >= library.topics.length
      ? offers[0]
      : offers.find((offer) => !memory.touchedTopics.has(offer.topicId)),
  reading: (offer, { rng, memory, library }) => {
    if (memory.touchedTopics.size >= library.topics.length) memory.afterEveryTopic = (memory.afterEveryTopic ?? 0) + 1;
    // The first open of a topic is a skim that reports something; later quick opens may report nothing at all.
    if (!memory.touchedTopics.has(offer.topicId)) {
      memory.touchedTopics.add(offer.topicId);
      return 'skim';
    }
    return mixOf(rng, { skim: 0.85, none: 0.15 });
  },
};

/** Starts on a Reel when one is offered and watches Reels through; reads a Scroll only when nothing else is left. */
export const reelWatcher: PersonaSpec = {
  id: 'reel-watcher',
  title: 'Reel-preferring watcher: stays in Reels',
  encounters: (config) => config.sessions.typical,
  choose: (offers) => offers.find((offer) => offer.kind === 'reel') ?? offers[0]!,
  reading: (offer, { rng }) =>
    offer.kind === 'reel' ? mixOf(rng, { read: 0.85, partial: 0.15 }) : mixOf(rng, { skim: 0.7, partial: 0.3 }),
};

/**
 * Reads one topic until a place of it exists on their map, then opens that region on purpose: the
 * explicit topic switch of the Universe. Offers inside a region are the person's own ask, not a
 * system-chosen subject, so the lab does not count them as repeats.
 */
export const topicSwitcher: PersonaSpec = {
  id: 'topic-switcher',
  title: 'Explicit topic switcher: opens a region of their map',
  choose: preferScroll,
  encounters: (config) => config.sessions.typical + 6,
  stopsWhenEmpty: false,
  move: ({ hasRegion, memory, index }) =>
    hasRegion && memory.regionsOpened < 2 && index >= 4 && index % 2 === 0 ? 'region' : 'vertical',
  reading: (offer, { rng, memory }) => {
    memory.focusTopic ??= offer.topicId;
    return offer.topicId === memory.focusTopic ? 'read' : mixOf(rng, { skim: 0.7, partial: 0.3 });
  },
};

/**
 * Reads whatever is new in full and leaves anything it has already met at once, tapping "Somewhere new" when it meets
 * one. It goes on until it has met the whole library and then for a few encounters more, to reach "nothing unseen is
 * left" and see what the system does there.
 */
export const bingeReader: PersonaSpec = {
  id: 'binge-reader',
  title: 'Binge reader: reads everything new, then keeps going past the end',
  stopsWhenEmpty: false,
  encounters: (config, library) => library.units.length * 3 + config.sessions.bingeTail,
  until: ({ memory, config }) => (memory.afterEverything ?? 0) >= config.sessions.bingeTail,
  move: ({ memory }) => (memory.skipping ? 'discover' : 'vertical'),
  choose: (offers) => offers.find((offer) => !offer.alreadyMet) ?? offers[0]!,
  reading: (offer, { memory, met, library }) => {
    memory.skipping = offer.alreadyMet;
    if (met.size >= library.units.length) memory.afterEverything = (memory.afterEverything ?? 0) + 1;
    return offer.alreadyMet ? 'none' : 'read';
  },
};

/** Reads one stop, then leaves a tab open on the next for hours with the first screen visible. */
export const idleTab: PersonaSpec = {
  id: 'idle-tab',
  title: 'Idle tab: left on one stop for hours',
  choose: preferScroll,
  encounters: () => 2,
  reading: (_offer, { index }) => (index === 0 ? 'read' : 'idle'),
};

/** Reads normally, pauses recording for a few stops (the person's own Pause), then resumes. */
export const pauseResume: PersonaSpec = {
  id: 'pause-resume',
  title: 'Recording paused, then resumed',
  choose: preferScroll,
  encounters: (config) => config.sessions.typical,
  reading: (_offer, { rng }) => mixOf(rng, { read: 0.7, skim: 0.3 }),
  recording: { pauseBefore: 4, resumeBefore: 8 },
};

/** The person who shares a world with the focused deep reader: likes and saves, reads and skims. */
export const sideBySideNeighbour: PersonaSpec = {
  id: 'side-by-side-neighbour',
  title: 'Neighbour: reads, likes and saves beside the deep reader',
  choose: preferScroll,
  encounters: (config) => config.sessions.typical,
  reading: (_offer, { rng }) => mixOf(rng, { read: 0.6, partial: 0.15, skim: 0.25 }),
  react: (_offer, reading, { rng }) =>
    reading === 'read' ? (rng.chance(0.4) ? 'like' : rng.chance(0.3) ? 'save' : undefined) : undefined,
};

/** Two units of one system that both have a Reel twin, in the order a person would follow their links. */
function twoReelsOfOneSystem(library: Library) {
  const bySystem = new Map<string, LibraryUnit[]>();
  for (const unit of library.units)
    if (unit.reel) bySystem.set(unit.systemId, [...(bySystem.get(unit.systemId) ?? []), unit]);
  const pair = [...bySystem.values()].find((units) => new Set(units.map((unit) => unit.topicId)).size >= 2);
  if (!pair) throw new Error('SIM_LIBRARY_HAS_NO_TWO_REELS_IN_ONE_SYSTEM');
  return pair.slice(0, 2).map((unit) => ({ unitId: unit.unitId, kind: 'reel' as const }));
}

/** Three Scrolls of one planet that cover two facets, in the order a person would follow their links. */
function threeScrollsOfOnePlanet(library: Library) {
  for (const topic of library.topics) {
    const units = library.ofTopic(topic);
    if (units.length >= 3 && new Set(units.map((unit) => unit.facetId)).size >= 2)
      return units.slice(0, 3).map((unit) => ({ unitId: unit.unitId, kind: 'scroll' as const }));
  }
  throw new Error('SIM_LIBRARY_HAS_NO_FORMABLE_PLANET');
}

/**
 * Follows two links to Reels of one system and watches each to the end. Two distinct qualified explanations under a
 * system are enough for it to form, whatever the format (equal status), so this scenario is exact where a reader who
 * wanders is not.
 */
export const linkReaderReels: PersonaSpec = {
  id: 'link-reader-reels',
  title: 'Reel-only reader: follows two shared links to Reels of one system',
  encounters: () => 2,
  script: twoReelsOfOneSystem,
  reading: () => 'read',
};

/** Follows links to three Scrolls of one planet over two facets and reads each in full: a planet must form. */
export const linkReaderScrolls: PersonaSpec = {
  id: 'link-reader-scrolls',
  title: 'Scroll reader: follows links to three Scrolls of one planet',
  encounters: () => 3,
  script: threeScrollsOfOnePlanet,
  reading: () => 'read',
};

/** Every Scroll of one planet in order, then the first two again: a reader who finishes a topic and comes back to it. */
function everyScrollOfOnePlanetThenTwoAgain(library: Library) {
  const units = library.ofTopic('space.exoplanets');
  const links = units.map((unit) => ({ unitId: unit.unitId, kind: 'scroll' as const }));
  return [...links, ...links.slice(0, 2)];
}

/**
 * Reads every unit of the one planet that has a recipe Create may still choose (`space.exoplanets`), then returns to two
 * of them. Each reading wakes the Planner, which asks for more of a topic the reader has now run out of.
 */
export const linkReaderExoplanets: PersonaSpec = {
  id: 'link-reader-exoplanets',
  title: 'Finishes a topic: reads every Scroll of one planet, then returns to two',
  encounters: (_config, library) => library.ofTopic('space.exoplanets').length + 2,
  script: everyScrollOfOnePlanetThenTwoAgain,
  reading: () => 'read',
};
