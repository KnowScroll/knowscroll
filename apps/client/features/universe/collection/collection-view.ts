import {
  orbitWords,
  placeLandmarks,
  type Collection,
  type CollectionLandmark,
  type ResumeOffer,
} from '@knowscroll/client-core';
import type { UniverseIndex } from '../universe-layout';

/** One landmark as a list reads it: its name, its finish and where it stands. */
export interface LandmarkRow {
  readonly id: string;
  readonly name: string;
  readonly tier: 'gold' | 'plain';
  /** "Gold finish" or "Plain finish": a finish is a keepsake, never a score. */
  readonly finish: string;
  /** The planet it stands on, or undefined while it waits for that planet to form. */
  readonly planet: { readonly id: string; readonly name: string } | undefined;
}

/** What the Universe draws and says of the person's play, from the read and the map as it is now. */
export interface CollectionView {
  /** Newest first, all of them. */
  readonly rows: readonly LandmarkRow[];
  /** The ones in the tray: their planet has not formed (D-084). */
  readonly waiting: readonly LandmarkRow[];
  /** The landmarks standing on each planet of the map. */
  readonly byPlanet: ReadonlyMap<string, readonly CollectionLandmark[]>;
  /** "Orbit · 1 of 3 days this week", or nothing when there is nothing to say yet. */
  readonly orbitText: string | undefined;
  readonly resume: ResumeOffer | null;
}

const idOf = (landmark: CollectionLandmark) => `${landmark.assetId}:${String(landmark.revision)}`;

/**
 * The collection as the Universe shows it (D-084, D-087, D-089, D-214). A landmark stands on the
 * planet of its Scroll's topic when that planet is on the map, and waits in the tray otherwise. Pure:
 * it reads the map's index and the collection, and changes neither.
 *
 * The Orbit is said once the person has played this week or has a landmark; before that the Universe
 * stays quiet, and a missed week says nothing at all (nothing here ever goes away).
 */
export function collectionViewOf(collection: Collection, index: UniverseIndex): CollectionView {
  const placed = placeLandmarks(
    collection.landmarks,
    collection.planets,
    (id) => index.byId.get(id)?.kind === 'planet',
  );
  const planetOf = new Map<string, { id: string; name: string }>();
  for (const [planetId, landmarks] of placed.byPlanet) {
    const name = index.byId.get(planetId)?.label;
    if (name !== undefined) for (const landmark of landmarks) planetOf.set(idOf(landmark), { id: planetId, name });
  }
  const rows = collection.landmarks.map((landmark): LandmarkRow => ({
    id: idOf(landmark),
    name: landmark.name,
    tier: landmark.tier,
    finish: landmark.tier === 'gold' ? 'Gold finish' : 'Plain finish',
    planet: planetOf.get(idOf(landmark)),
  }));
  const orbit = collection.orbit;
  return {
    rows,
    waiting: rows.filter((row) => row.planet === undefined),
    byPlanet: placed.byPlanet,
    orbitText: orbit && (orbit.days > 0 || rows.length > 0) ? orbitWords(orbit) : undefined,
    resume: collection.resume,
  };
}
