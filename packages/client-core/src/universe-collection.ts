import {
  PlaceConceptsSchema,
  ReadLandmarksResponseSchema,
  ReadOrbitResponseSchema,
  ResumeResponseSchema,
  type LandmarkTier,
  type Orbit,
} from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import type { AccountScope } from './account-scope';

/**
 * What the Universe shows of the person's play (D-084, D-087, D-089, D-214, D-215): the landmarks they
 * earned, this week's Orbit as text, and the next Part of a series they started. It is a read of their
 * own records, drawn over the map and never fed back into it.
 */

/** A landmark the person earned, as the Universe lists it. */
export interface CollectionLandmark {
  readonly key: string;
  readonly name: string;
  readonly tier: LandmarkTier;
  readonly assetId: string;
  readonly revision: number;
  readonly earnedAt: string;
  /** The catalogue topic of its Scroll: what ties it to a planet once that planet has formed. */
  readonly topicId?: string;
}

/** "Resume Part 2 of 3": the next Part the person has not opened. */
export interface ResumeOffer {
  readonly assetId: string;
  readonly title: string;
  readonly part: number;
  readonly total: number;
}

export interface PlanetTopic {
  readonly id: string;
  readonly topicId: string;
}

export interface Collection {
  readonly landmarks: readonly CollectionLandmark[];
  /** Absent when this week's Orbit could not be read. */
  readonly orbit: Orbit | undefined;
  readonly resume: ResumeOffer | null;
  /** The established planets and their topics, read from Geography, for setting landmarks on them. */
  readonly planets: readonly PlanetTopic[];
}

export const NO_COLLECTION: Collection = { landmarks: [], orbit: undefined, resume: null, planets: [] };

export type CollectionRead =
  { readonly status: 'ready'; readonly collection: Collection } | { readonly status: 'unavailable' };

/** The device's own time zone, which names the days of the week; UTC when it cannot say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** One read that may fail without hiding the others. */
async function tolerated<T>(
  read: () => Promise<unknown>,
  parse: (raw: unknown) => T | undefined,
): Promise<T | undefined> {
  try {
    return parse(await read());
  } catch (error) {
    // An authority problem ends the whole read; anything else only leaves this part out.
    if (apiProblem(error)?.code === 'PRIVACY_EPOCH_CHANGED') throw error;
    return undefined;
  }
}

/**
 * Reads the person's collection: landmarks and the Orbit from `play`, the next Part from `experience`
 * and the topic of each planet from `geography` (the one place that knows which topic a planet is).
 * The four reads are separate on purpose: `play` never reaches Geography, so the join of a landmark to
 * a planet is made here on the topic, a public catalogue id.
 *
 * Authority: the actual scope's own session. Side effects: none, on the server or the device. Failure:
 * a part that cannot be read keeps its value in `previous` and the rest is shown; `unavailable` only when none could
 * be, and the caller keeps what it had.
 */
export async function readCollection(
  scope: AccountScope,
  signal?: AbortSignal,
  previous: Collection = NO_COLLECTION,
): Promise<CollectionRead> {
  if (!scope.active) return { status: 'unavailable' };
  const options = signal ? { signal } : undefined;
  try {
    const [landmarks, orbit, resume, places] = await Promise.all([
      tolerated(
        () => scope.api.play.readLandmarks({}, options),
        (raw) => ReadLandmarksResponseSchema.parse(raw).landmarks,
      ),
      tolerated(
        () => scope.api.play.readOrbit({ timeZone: deviceTimeZone() }, options),
        (raw) => ReadOrbitResponseSchema.parse(raw).orbit,
      ),
      tolerated(
        () => scope.api.experience.resume({}, options),
        (raw) => ResumeResponseSchema.parse(raw).resume,
      ),
      tolerated(
        () => scope.api.geography.placeConcepts({}, options),
        (raw) => {
          const concepts = PlaceConceptsSchema.parse(raw);
          return concepts.universeId === scope.account.universeId &&
            concepts.privacyEpoch === scope.account.privacyEpoch
            ? concepts.planets
            : undefined;
        },
      ),
    ]);
    if (landmarks === undefined && orbit === undefined && resume === undefined && places === undefined)
      return { status: 'unavailable' };
    return {
      status: 'ready',
      collection: {
        // A part that could not be read keeps what the screen already showed (a dropped connection never empties it).
        landmarks: landmarks ?? previous.landmarks,
        orbit: orbit ?? previous.orbit,
        resume: resume === undefined ? previous.resume : resume,
        planets: places ?? previous.planets,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Where the landmarks stand: on a planet of the map, or in the tray until their planet has formed (D-084). */
export interface PlacedLandmarks {
  readonly byPlanet: ReadonlyMap<string, readonly CollectionLandmark[]>;
  readonly waiting: readonly CollectionLandmark[];
}

/**
 * Sets each landmark on the planet of its topic when that planet is on the map now, and otherwise in
 * the tray. A landmark with no topic, or whose planet has not formed, waits; one whose planet exists
 * attaches at once, with no other change. Pure: it forms, moves and changes nothing, and what a
 * landmark is (gold or plain) never decides where it goes.
 */
export function placeLandmarks(
  landmarks: readonly CollectionLandmark[],
  planets: readonly PlanetTopic[],
  onMap: (planetId: string) => boolean,
): PlacedLandmarks {
  const planetOfTopic = new Map<string, string>();
  for (const planet of planets)
    if (onMap(planet.id) && !planetOfTopic.has(planet.topicId)) planetOfTopic.set(planet.topicId, planet.id);
  const byPlanet = new Map<string, CollectionLandmark[]>();
  const waiting: CollectionLandmark[] = [];
  for (const landmark of landmarks) {
    const planetId = landmark.topicId === undefined ? undefined : planetOfTopic.get(landmark.topicId);
    if (planetId === undefined) waiting.push(landmark);
    else byPlanet.set(planetId, [...(byPlanet.get(planetId) ?? []), landmark]);
  }
  return { byPlanet, waiting };
}

/**
 * "Orbit · 1 of 3 days this week", the Orbit as the Universe says it (D-087). A closed week says so; a week
 * that has not been played says nothing is lost, because nothing is.
 */
export function orbitWords(orbit: Orbit): string {
  const days = `Orbit · ${Math.min(orbit.days, orbit.goal)} of ${orbit.goal} days this week`;
  return orbit.closed ? `${days} · closed` : days;
}
