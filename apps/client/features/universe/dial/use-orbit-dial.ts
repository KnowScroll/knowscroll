import { useMemo, useState } from 'react';
import type { RoomStation } from '@knowscroll/contracts';
import type { SceneLook } from '@knowscroll/scene-core';
import type { UniverseIndex } from '../universe-layout';
import type { UniverseMapSession, UniverseViewState } from '../universe-session';
import {
  buildDial,
  filterCounts,
  searchPlanets,
  searchSystems,
  wheelSystems,
  type DialFilter,
  type DialSystem,
} from './dial-model';

export type DialSearch = 'systems' | 'planets' | null;

/**
 * What the orbit dial is showing and what it can do next. The choice of system and planet, the
 * filter and the query live here; the systems, planets and matches are derived from the reads the
 * Universe already holds, so nothing in this hook fetches, writes or keeps a query beyond the screen.
 */
export function useOrbitDial(input: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly looks: readonly SceneLook[] | undefined;
  readonly stations: readonly RoomStation[] | undefined;
  readonly visitor: boolean;
}) {
  const { session, state, index, looks, stations, visitor } = input;
  const places = session.places();
  const all = useMemo(
    () =>
      buildDial({
        index,
        looks,
        stations: visitor ? [] : (stations ?? []),
        hereRegionId: state.youWereHere,
        herePlaceId: state.focusId ?? state.lastPlace?.id,
      }),
    [index, looks, stations, visitor, state.youWereHere, state.focusId, state.lastPlace?.id],
  );
  const [filter, setFilter] = useState<DialFilter>('all');
  const [wheelOpen, setWheelOpen] = useState(false);
  const [turning, setTurning] = useState(false);
  const [searching, setSearching] = useState<DialSearch>(null);
  const [query, setQuery] = useState('');
  const [everywhere, setEverywhere] = useState(false);
  const [chosenSystem, setChosenSystem] = useState<string | undefined>(undefined);
  const [chosenPlanet, setChosenPlanet] = useState<string | undefined>(undefined);

  const systemMatches = useMemo(
    () => (searching === 'systems' && query.trim() ? searchSystems(places, query) : undefined),
    [searching, query, places],
  );
  const shown = useMemo(() => wheelSystems(all, filter, systemMatches), [all, filter, systemMatches]);
  const startAt = all.find((system) => system.here)?.id ?? shown[0]?.id;
  const systemAt = Math.max(
    0,
    shown.findIndex((system) => system.id === (chosenSystem ?? startAt)),
  );
  const system: DialSystem | undefined = shown[systemAt];
  const named = system?.planets.findIndex((entry) => entry.id === chosenPlanet) ?? -1;
  const planetAt = named >= 0 ? named : Math.max(0, system?.planets.findIndex((entry) => entry.here) ?? 0);
  const planetSearch = useMemo(
    () => (searching === 'planets' && query.trim() ? searchPlanets(places, all, system, query, everywhere) : undefined),
    [searching, query, places, all, system, everywhere],
  );
  // What matched in the other systems, for the "Also elsewhere" row and the Everywhere count.
  const elsewhere = useMemo(
    () => (planetSearch ? searchPlanets(places, all, system, query, true).elsewhere : []),
    [planetSearch, places, all, system, query],
  );

  return {
    all,
    shown,
    system,
    systemAt,
    planetAt,
    filter,
    counts: filterCounts(all),
    /** The wheel is big: a finger turns it, the row was touched, or systems are being searched. */
    open: wheelOpen || turning || searching === 'systems',
    turning,
    searching,
    query,
    everywhere,
    systemMatches,
    planetSearch,
    elsewhere,
    lit: new Set(planetSearch ? [...planetSearch.here, ...planetSearch.elsewhere].map((m) => m.planet.id) : []),
    setFilter,
    setQuery,
    setEverywhere,
    openWheel: () => setWheelOpen(true),
    turn: (isTurning: boolean) => {
      setTurning(isTurning);
      if (isTurning) setWheelOpen(true);
    },
    choosePlanet: setChosenPlanet,
    chooseSystem: (id: string) => {
      setChosenSystem(id);
      setChosenPlanet(undefined);
      if (searching === 'systems') {
        setSearching(null);
        setQuery('');
      }
      setWheelOpen(false);
    },
    startSearch: () => {
      setSearching(wheelOpen || turning ? 'systems' : 'planets');
      setQuery('');
      setEverywhere(false);
    },
    stopSearch: () => {
      setSearching(null);
      setQuery('');
    },
  };
}

export type OrbitDialState = ReturnType<typeof useOrbitDial>;
