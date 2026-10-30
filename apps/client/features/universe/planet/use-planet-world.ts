import { useEffect, useReducer } from 'react';
import { buildGlobe, buildMap, type GlobeWorld, type MapWorld, type WorldSpec } from '@knowscroll/scene-core';

/**
 * Worlds already drawn, by what they are drawn from. A world is a pure function of its spec, so a
 * cached one is exactly what a new one would be. A few are kept, least recently used first out.
 * They are kept by the Universe session that asked, so they go with it when the account scope ends
 * (logout, account switch, privacy reset) and are never shared between accounts.
 */
const KEPT = 6;
type Kept = GlobeWorld | MapWorld | 'refused';
const sessions = new WeakMap<object, Map<string, Kept>>();

const keyOf = (kind: 'globe' | 'map', spec: WorldSpec) =>
  `${kind}|${spec.seed}|${spec.type}|${spec.variant}|${spec.siteCount}`;

function keptBy(session: object): Map<string, Kept> {
  const found = sessions.get(session);
  if (found) return found;
  const created = new Map<string, Kept>();
  sessions.set(session, created);
  return created;
}

function keep(worlds: Map<string, Kept>, key: string, world: Kept): void {
  worlds.delete(key);
  worlds.set(key, world);
  while (worlds.size > KEPT) worlds.delete(worlds.keys().next().value!);
}

export type Drawing<World> =
  { readonly status: 'drawing' } | { readonly status: 'refused' } | { readonly status: 'ready'; readonly world: World };

function useWorld<World extends GlobeWorld | MapWorld>(
  session: object,
  kind: World['kind'],
  spec: WorldSpec | undefined,
  build: (spec: WorldSpec) => World,
): Drawing<World> {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const worlds = keptBy(session);
  const key = spec ? keyOf(kind, spec) : undefined;
  useEffect(() => {
    if (!spec || !key || worlds.has(key)) return;
    // Off the first frame of the screen: building a world is the heaviest thing a planet does.
    const handle = setTimeout(() => {
      try {
        keep(worlds, key, build(spec));
      } catch {
        keep(worlds, key, 'refused');
      }
      refresh();
    }, 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `build` is one of two module functions, and `spec` is what `key` stands for.
  }, [key, worlds]);
  const found = key ? worlds.get(key) : undefined;
  if (found === 'refused') return { status: 'refused' };
  if (found && found.kind === kind) return { status: 'ready', world: found as World };
  return { status: 'drawing' };
}

/** The globe's band for a planet: built after the first frame, then kept by the session. */
export const useGlobeWorld = (session: object, spec: WorldSpec | undefined) =>
  useWorld<GlobeWorld>(session, 'globe', spec, buildGlobe);

/** The landed map for a planet: built after the first frame, then kept by the session. */
export const useMapWorld = (session: object, spec: WorldSpec | undefined) =>
  useWorld<MapWorld>(session, 'map', spec, buildMap);
