import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SceneLook } from '@knowscroll/scene-core';
import type { FrameScheduler } from '../space/render-loop';
import type { ScriptFrame, SpaceScript } from '../space/space-script';
import type { UniverseMapSession } from '../universe-session';
import type { UniverseView } from '../universe-layout';
import { looksById } from '../space/space-model';
import { ENTER_PLANET, type GlobePlacement } from './enter-planet';
import { ENTER_SYSTEM } from './enter-system';
import { ENTER_WORLD } from './enter-world';
import { STEP_UP_SECONDS } from './step-up';
import { createAnimationPlayer, type AnimationKind, type AnimationPlayer } from './player';

/** The step down a change of view is, if it is one of the three the design animates (D-114). */
export type StepAnimation =
  | { readonly kind: 'enter-system'; readonly systemId: string; readonly from: UniverseView }
  | {
      readonly kind: 'enter-planet' | 'enter-planet-rings';
      readonly systemId: string;
      readonly planetId: string;
      readonly from: UniverseView;
    }
  | { readonly kind: 'enter-world'; readonly planetId: string; readonly from: UniverseView }
  /** One step up: a 0.3 s cross-fade from `from` to the view that was entered (D-093, D-116). */
  | { readonly kind: 'step-up'; readonly from: UniverseView; readonly to: UniverseView };

export const SECONDS: Readonly<Record<Exclude<AnimationKind, 'first-open'>, number>> = {
  'enter-system': ENTER_SYSTEM.seconds,
  'enter-planet': ENTER_PLANET.seconds,
  'enter-planet-rings': ENTER_PLANET.seconds,
  'enter-world': ENTER_WORLD.seconds,
  'step-up': STEP_UP_SECONDS,
};

/** Identifies a view, so a re-render that changes nothing is not a step. */
export function viewKey(view: UniverseView): string {
  if (view.kind === 'universe') return 'universe';
  if (view.kind === 'system') return `system:${view.system.objectId}`;
  return `planet:${view.planet.objectId}:${view.landed ? 'landed' : 'globe'}:${view.selectedRegion?.objectId ?? ''}`;
}

/**
 * Which animation a change of view is, if any. A single step down is one of the three entering animations: the whole map
 * to a system, a system to one of its own planets, a planet's globe to its map at planet level. A single step up, to the
 * parent just left (a planet to its system, a planet's map to its globe, a system to the whole map), is a 0.3 s
 * cross-fade (D-093, D-116). A long jump (search to a region, the dial across systems) goes straight to the destination.
 * `ringed` says the planet has rings or a moon.
 */
export function stepBetween(
  from: UniverseView,
  to: UniverseView,
  looks: ReadonlyMap<string, SceneLook>,
): StepAnimation | undefined {
  if (from.kind === 'universe' && to.kind === 'system')
    return { kind: 'enter-system', systemId: to.system.objectId, from };
  if (from.kind === 'system' && to.kind === 'planet' && !to.landed && to.planet.parentId === from.system.objectId) {
    const look = looks.get(to.planet.objectId);
    const ringed = look?.kind === 'planet' && (look.rings || look.moon);
    return {
      kind: ringed ? 'enter-planet-rings' : 'enter-planet',
      systemId: from.system.objectId,
      planetId: to.planet.objectId,
      from,
    };
  }
  if (
    from.kind === 'planet' &&
    !from.landed &&
    to.kind === 'planet' &&
    to.landed &&
    to.selectedRegion === undefined &&
    to.planet.objectId === from.planet.objectId
  )
    return { kind: 'enter-world', planetId: to.planet.objectId, from };
  return isStepUp(from, to) ? { kind: 'step-up', from, to } : undefined;
}

/** Whether `to` is the view one level above `from`, the one just left. */
function isStepUp(from: UniverseView, to: UniverseView): boolean {
  if (from.kind === 'system') return to.kind === 'universe';
  if (from.kind !== 'planet') return false;
  if (!from.landed) return to.kind === 'system' && to.system.objectId === from.planet.parentId;
  return (
    from.selectedRegion === undefined &&
    to.kind === 'planet' &&
    !to.landed &&
    to.planet.objectId === from.planet.objectId
  );
}

/** What the overlays of an animation read: the latest projection of the 3D scene, as the renderer reports it. */
export interface ScriptFeed {
  readonly latest: () => ScriptFrame | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A feed that holds the latest frame the renderer reported and tells its listeners. */
function createScriptFeed(): ScriptFeed & { push: (frame: ScriptFrame) => void } {
  let latest: ScriptFrame | undefined;
  const listeners = new Set<() => void>();
  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    push(frame) {
      latest = frame;
      for (const listener of [...listeners]) listener();
    },
  };
}

export const rafScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface UniverseAnimation {
  /** The animation playing now, or none. */
  readonly active: StepAnimation | undefined;
  readonly player: AnimationPlayer;
  readonly feed: ScriptFeed;
  /** The renderer's script for the playing animation, if the 3D scene has a part in it. */
  readonly script: SpaceScript | undefined;
}

/**
 * Plays the animation a change of view calls for. A step down is noticed while rendering, so the screen's
 * first frame is already the animation's first frame (no flash of the destination). The session's gate is
 * closed for as long as it plays: taps are ignored, and Back jumps it to its end frame. `enabled` is off
 * under reduced motion, with Simple drawing and on the desktop layout, where the destination shows at once.
 */
export function useUniverseAnimation(options: {
  readonly session: UniverseMapSession;
  readonly view: UniverseView;
  readonly looks: readonly SceneLook[] | undefined;
  readonly enabled: boolean;
  /** Where the planet view puts its globe, for the glide down to a planet. */
  readonly globe: GlobePlacement;
}): UniverseAnimation {
  const { session, view, looks, enabled, globe } = options;
  const player = useMemo(() => createAnimationPlayer(rafScheduler), []);
  const key = viewKey(view);
  const [tracked, setTracked] = useState({ key, view });
  const [active, setActive] = useState<StepAnimation | undefined>(undefined);
  if (tracked.key !== key) {
    setTracked({ key, view });
    setActive(enabled ? stepBetween(tracked.view, view, looksById(looks)) : undefined);
  }
  // Turning the animations off (reduced motion, Simple drawing) while one plays ends it.
  if (!enabled && active !== undefined) setActive(undefined);

  const playing = useRef(false);
  useLayoutEffect(() => {
    playing.current = active !== undefined;
  });
  const clock = useCallback(
    (): number => player.current()?.t ?? (playing.current ? 0 : Number.MAX_SAFE_INTEGER),
    [player],
  );

  const [feed] = useState(createScriptFeed);

  useLayoutEffect(() => {
    if (active === undefined) return;
    const ended = player.onEnd(() => setActive(undefined));
    session.gate.set(() => player.finish());
    player.start(active.kind, SECONDS[active.kind]);
    return () => {
      ended();
      session.gate.set(undefined);
    };
  }, [active, player, session]);
  useEffect(() => () => player.dispose(), [player]);

  const script = useMemo<SpaceScript | undefined>(() => {
    if (active === undefined) return undefined;
    if (active.kind === 'enter-system')
      return { kind: 'enter-system', systemId: active.systemId, clock, onFrame: feed.push };
    if (active.kind === 'enter-world' || active.kind === 'step-up') return undefined;
    return {
      kind: 'enter-planet',
      systemId: active.systemId,
      planetId: active.planetId,
      ringed: active.kind === 'enter-planet-rings',
      globe,
      clock,
      onFrame: feed.push,
    };
  }, [active, clock, feed, globe]);

  return { active, player, feed, script };
}
