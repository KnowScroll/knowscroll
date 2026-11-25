import type { AvailableRegionPreview } from '@knowscroll/client-core';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { DRAW_LIMITS, INITIAL_FRAME } from '../universe/universe-camera';
import { NO_COLLECTION_STATE } from '../universe/universe-collection-reader';
import { NO_DUST } from '../universe/universe-dust';
import { createVisitMapSession } from './visit-map-session';
import { visitorDescriptors, visitorLooks } from './visitor-scene';

/**
 * Pins what a friend's map session does today, so that moving it onto a shared navigation core can be shown to change
 * nothing. Where it differs from the person's own map (`universe-session.test.ts`), the test says what the visit does.
 */

const id = (n: number) => `0199b000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const system = (n: number, planets: number) => ({
  publicSystemId: id(n),
  label: `System ${String(n)}`,
  planets: Array.from({ length: planets }, (_, index) => ({
    publicPlanetId: id(n * 100 + index),
    label: `Planet ${String(n)}.${String(index)}`,
  })),
});
const owner = id(9999);
const SYSTEMS = [system(1, 2), system(2, 2)];
const DESCRIPTORS = visitorDescriptors(owner, SYSTEMS);
const LOOKS = visitorLooks(SYSTEMS);
const S1 = id(1);
const S2 = id(2);
const P10 = id(100);
const P11 = id(101);
const P20 = id(200);
const STAR1 = DESCRIPTORS.find((descriptor) => descriptor.kind === 'star' && descriptor.parentId === S1)!.objectId;

/** A session with the two systems loaded and its screen in the foreground, as the visit screen leaves it. */
function open(descriptors: readonly SceneDescriptor[] = DESCRIPTORS) {
  const refresh = jest.fn(() => Promise.resolve());
  const session = createVisitMapSession({ refresh });
  session.setDescriptors(descriptors, LOOKS);
  session.setForeground(true);
  return { session, refresh };
}
const without = (...ids: string[]) => DESCRIPTORS.filter((descriptor) => !ids.includes(descriptor.objectId));

describe('a friend’s map session: starting state', () => {
  it('starts on the whole map, ready, with nothing of the visitor’s own in it', () => {
    const session = createVisitMapSession({ refresh: () => Promise.resolve() });
    expect(session.getState()).toEqual({
      read: { status: 'ready', active: true },
      frame: INITIAL_FRAME,
      focusId: null,
      landed: false,
      overlay: null,
      detail: 'full',
      reducedMotion: true,
      historyDepth: 0,
      regionPreview: { status: 'idle' },
      lately: false,
      dust: NO_DUST,
      collection: NO_COLLECTION_STATE,
      lastPlace: undefined,
      absent: false,
      selectedId: null,
      youWereHere: null,
      seenLandmark: null,
      findsFor: null,
    });
    expect(session.places()).toEqual([]);
    expect(session.descriptors()).toEqual([]);
  });

  it('lists the places the owner shared, as ids, parents, kinds, labels and truth, and keeps the looks it was given', () => {
    const { session } = open();
    expect(session.descriptors()).toBe(DESCRIPTORS);
    expect(session.places()).toEqual(
      DESCRIPTORS.map((place) => ({
        id: place.objectId,
        parentId: place.parentId,
        kind: place.kind,
        label: place.label,
        truthStatus: place.truthStatus,
      })),
    );
    expect(session.getState().looks).toBe(LOOKS);
  });
});

describe('a friend’s map session: when it is live', () => {
  it('does nothing while its screen is not in the foreground, and picks up where it was when it returns', () => {
    const { session, refresh } = open();
    session.focus(S1);
    session.setForeground(false);
    expect(session.focus(S2)).toBe(false);
    expect(session.canBack()).toBe(false);
    expect(session.back()).toBe(false);
    expect(session.up()).toBe(false);
    expect(session.escape()).toBe(false);
    session.camera({ x: 5, y: 5, scale: 2 });
    session.fit();
    session.select(P10);
    session.showOverlay('outline');
    expect(session.geometry(session.descriptors()[0]!)).toBeUndefined();
    expect(session.getState().focusId).toBe(S1);
    expect(session.getState().frame).toEqual(INITIAL_FRAME);
    expect(session.getState().selectedId).toBeNull();
    expect(session.getState().overlay).toBeNull();
    void session.refresh();
    expect(refresh).not.toHaveBeenCalled();
    // The places themselves are still listed, and a new list is still taken, while it is away.
    expect(session.places()).toHaveLength(DESCRIPTORS.length);
    session.setForeground(true);
    expect(session.canBack()).toBe(true);
    expect(session.back()).toBe(true);
    expect(session.getState().focusId).toBeNull();
  });

  it('reads again through the screen’s Refresh only while live', async () => {
    const { session, refresh } = open();
    await session.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a friend’s map session: focus and Back', () => {
  it('flying into a system or a planet pushes one Back step and shows it framed on its own', () => {
    const { session } = open();
    session.camera({ x: 40, y: -20, scale: 2 });
    expect(session.focus(S1)).toBe(true);
    expect(session.getState().focusId).toBe(S1);
    expect(session.getState().frame).toEqual(INITIAL_FRAME);
    expect(session.getState().historyDepth).toBe(1);
    expect(session.canBack()).toBe(true);
    expect(session.focus(P10)).toBe(true);
    expect(session.getState().focusId).toBe(P10);
    expect(session.getState().historyDepth).toBe(2);
  });

  it('a place that is not on the list is refused and changes nothing', () => {
    const { session } = open();
    const before = session.getState();
    const heard = jest.fn();
    session.subscribe(heard);
    expect(session.focus(id(424242))).toBe(false);
    expect(session.getState()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
  });

  it('focusing closes the sheet and the pick, takes the notice away, and ignores the `land` option', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    session.setDescriptors(without(S1), LOOKS);
    session.back();
    expect(session.getState().notice).toBe('place_unavailable');
    session.setDescriptors(DESCRIPTORS, LOOKS);
    session.showOverlay('search');
    session.select(P20);
    expect(session.getState().overlay).toBe('search');
    expect(session.getState().selectedId).toBe(P20);
    expect(session.focus(P20, { land: true })).toBe(true);
    expect(session.getState().overlay).toBeNull();
    expect(session.getState().selectedId).toBeNull();
    expect(session.getState().landed).toBe(false);
    expect(session.getState().notice).toBeUndefined();
  });

  it('moving between two planets of one system replaces the view: no extra Back step', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    expect(session.getState().historyDepth).toBe(2);
    expect(session.focus(P11)).toBe(true);
    expect(session.getState().focusId).toBe(P11);
    expect(session.getState().historyDepth).toBe(2);
    // Focusing the planet already in focus is the same case: still no step.
    expect(session.focus(P11)).toBe(true);
    expect(session.getState().historyDepth).toBe(2);
    // One Back goes to the system the planets were entered from, not to the first planet.
    session.back();
    expect(session.getState().focusId).toBe(S1);
    session.back();
    expect(session.getState().focusId).toBeNull();
    expect(session.canBack()).toBe(false);
  });

  it('moving from a system to a system, from a planet to another system’s planet, or from a planet to its system does add a step', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(S2);
    expect(session.getState().historyDepth).toBe(2);
    session.focus(P20);
    expect(session.getState().historyDepth).toBe(3);
    session.focus(P10);
    expect(session.getState().historyDepth).toBe(4);
    session.focus(S1);
    expect(session.getState().historyDepth).toBe(5);
  });

  it('Back restores the frame the camera had at each step', () => {
    const { session } = open();
    session.camera({ x: 21.5, y: -14, scale: 0.5 });
    session.focus(S1);
    session.camera({ x: 3, y: 4, scale: 3 });
    session.focus(P10);
    session.back();
    expect(session.getState().focusId).toBe(S1);
    expect(session.getState().frame).toEqual({ x: 3, y: 4, scale: 3 });
    session.back();
    expect(session.getState().focusId).toBeNull();
    expect(session.getState().frame).toEqual({ x: 21.5, y: -14, scale: 0.5 });
  });

  it('keeps at most as many Back steps as the draw limit, dropping the oldest', () => {
    const { session } = open();
    for (let step = 0; step < DRAW_LIMITS.history + 8; step++) session.focus(step % 2 === 0 ? S1 : S2);
    expect(session.getState().historyDepth).toBe(DRAW_LIMITS.history);
  });

  it('Back closes a sheet first, then a pick, then goes back a step; with nothing to go back to it is refused', () => {
    const { session } = open();
    session.focus(S1);
    session.showOverlay('search');
    session.select(P10);
    expect(session.getState().overlay).toBe('search');
    expect(session.getState().selectedId).toBe(P10);
    expect(session.back()).toBe(true);
    expect(session.getState().overlay).toBeNull();
    expect(session.getState().selectedId).toBe(P10);
    expect(session.getState().focusId).toBe(S1);
    expect(session.back()).toBe(true);
    expect(session.getState().selectedId).toBeNull();
    expect(session.getState().focusId).toBe(S1);
    expect(session.getState().historyDepth).toBe(1);
    expect(session.back()).toBe(true);
    expect(session.getState().focusId).toBeNull();
    expect(session.back()).toBe(false);
  });

  it('can go back while a sheet, a pick or a Back step exists, and not otherwise', () => {
    const { session } = open();
    expect(session.canBack()).toBe(false);
    session.showOverlay('outline');
    expect(session.canBack()).toBe(true);
    session.showOverlay(null);
    expect(session.canBack()).toBe(false);
    session.select(S1);
    expect(session.canBack()).toBe(true);
    session.select(null);
    expect(session.canBack()).toBe(false);
    session.focus(S1);
    expect(session.canBack()).toBe(true);
    session.back();
    expect(session.canBack()).toBe(false);
  });

  it('a Back step whose place went away shows the notice, lands on the whole map, and keeps the steps before it', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    expect(session.getState().historyDepth).toBe(2);
    // The system is withdrawn but the planet still on the list (the focused place is still there, so nothing is stale yet).
    session.setDescriptors(without(S1), LOOKS);
    expect(session.getState().focusId).toBe(P10);
    expect(session.getState().historyDepth).toBe(2);
    expect(session.getState().notice).toBeUndefined();
    session.camera({ x: 9, y: 9, scale: 3 });
    expect(session.back()).toBe(true);
    expect(session.getState().focusId).toBeNull();
    expect(session.getState().frame).toEqual(INITIAL_FRAME);
    expect(session.getState().overlay).toBeNull();
    expect(session.getState().notice).toBe('place_unavailable');
    // Unlike the own map, history is not cleared: the step before still stands.
    expect(session.getState().historyDepth).toBe(1);
    expect(session.canBack()).toBe(true);
    // Going back again from there returns to the whole map and takes the notice away.
    expect(session.back()).toBe(true);
    expect(session.getState().focusId).toBeNull();
    expect(session.getState().notice).toBeUndefined();
    expect(session.getState().historyDepth).toBe(0);
  });
});

describe('a friend’s map session: up and escape', () => {
  it('up from a planet goes to its system, with a Back step and a fresh frame', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    session.camera({ x: 7, y: 7, scale: 2 });
    expect(session.up()).toBe(true);
    expect(session.getState().focusId).toBe(S1);
    expect(session.getState().frame).toEqual(INITIAL_FRAME);
    expect(session.getState().historyDepth).toBe(3);
    // The step it pushed returns to the planet at the frame it had.
    session.back();
    expect(session.getState().focusId).toBe(P10);
    expect(session.getState().frame).toEqual({ x: 7, y: 7, scale: 2 });
  });

  it('up from a system goes to the whole universe, because the universe is not a place on the list', () => {
    const { session } = open();
    session.focus(S1);
    expect(session.up()).toBe(true);
    expect(session.getState().focusId).toBeNull();
  });

  it('up from a star goes to its system; up from a planet whose parent is a star goes to the whole universe', () => {
    const withStarParent = DESCRIPTORS.map((place) => (place.objectId === P11 ? { ...place, parentId: STAR1 } : place));
    const { session } = open(withStarParent);
    session.focus(STAR1);
    session.up();
    expect(session.getState().focusId).toBe(S1);
    session.focus(P11);
    session.up();
    expect(session.getState().focusId).toBeNull();
  });

  it('up on the whole map still answers true and still pushes a Back step (the visit does not guard it)', () => {
    const { session } = open();
    expect(session.up()).toBe(true);
    expect(session.getState().focusId).toBeNull();
    expect(session.getState().historyDepth).toBe(1);
    expect(session.canBack()).toBe(true);
  });

  it('up closes the sheet and the pick but, unlike focus, leaves a notice standing', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    session.setDescriptors(without(S1), LOOKS);
    session.back();
    expect(session.getState().notice).toBe('place_unavailable');
    session.setDescriptors(DESCRIPTORS, LOOKS);
    expect(session.getState().notice).toBe('place_unavailable');
    session.showOverlay('outline');
    session.select(P10);
    session.up();
    expect(session.getState().overlay).toBeNull();
    expect(session.getState().selectedId).toBeNull();
    expect(session.getState().notice).toBe('place_unavailable');
  });

  it('escape closes what is open one thing at a time, then steps up, and does nothing on the whole map', () => {
    const { session } = open();
    expect(session.escape()).toBe(false);
    session.focus(S1);
    session.focus(P10);
    session.showOverlay('search');
    session.select(P11);
    expect(session.escape()).toBe(true);
    expect(session.getState().overlay).toBeNull();
    expect(session.getState().selectedId).toBe(P11);
    expect(session.escape()).toBe(true);
    expect(session.getState().selectedId).toBeNull();
    expect(session.getState().focusId).toBe(P10);
    expect(session.escape()).toBe(true);
    expect(session.getState().focusId).toBe(S1);
    expect(session.escape()).toBe(true);
    expect(session.getState().focusId).toBeNull();
    const depth = session.getState().historyDepth;
    expect(session.escape()).toBe(false);
    expect(session.getState().historyDepth).toBe(depth);
  });
});

describe('a friend’s map session: select, sheets, camera and fit', () => {
  it('select picks a place on the list, ignores an unknown id, and clears with null', () => {
    const { session } = open();
    session.select(S1);
    expect(session.getState().selectedId).toBe(S1);
    session.select(id(424242));
    expect(session.getState().selectedId).toBe(S1);
    session.select(P20);
    expect(session.getState().selectedId).toBe(P20);
    session.select(null);
    expect(session.getState().selectedId).toBeNull();
    expect(session.getState().historyDepth).toBe(0);
  });

  it('opens and closes sheets, a sheet takes the pick away, and the place card is refused', () => {
    const { session } = open();
    session.select(S1);
    session.showOverlay('outline');
    expect(session.getState().overlay).toBe('outline');
    expect(session.getState().selectedId).toBeNull();
    session.showOverlay('place');
    expect(session.getState().overlay).toBe('outline');
    session.focus(S1);
    session.showOverlay('place');
    expect(session.getState().overlay).toBeNull();
    session.showOverlay('settings');
    expect(session.getState().overlay).toBe('settings');
    session.showOverlay(null);
    expect(session.getState().overlay).toBeNull();
  });

  it('camera keeps the frame within the bounds and nothing more: no per-kind zoom limit', () => {
    const { session } = open();
    session.camera({ x: 12.5, y: -3, scale: 1.5 });
    expect(session.getState().frame).toEqual({ x: 12.5, y: -3, scale: 1.5 });
    session.camera({ x: 99999, y: -99999, scale: 1000 });
    expect(session.getState().frame).toEqual({ x: 10000, y: -10000, scale: 16 });
    session.camera({ x: 0, y: 0, scale: 0.001 });
    expect(session.getState().frame.scale).toBe(0.125);
    session.camera({ x: Number.NaN, y: Number.POSITIVE_INFINITY, scale: Number.NaN });
    expect(session.getState().frame).toEqual({ x: 0, y: 0, scale: 1 });
    // The same bounds on a system and on a planet: a system view may be zoomed to 16 here.
    session.focus(S1);
    session.camera({ x: 0, y: 0, scale: 16 });
    expect(session.getState().frame.scale).toBe(16);
    session.focus(P10);
    session.camera({ x: 0, y: 0, scale: 16 });
    expect(session.getState().frame.scale).toBe(16);
    expect(session.getState().historyDepth).toBe(2);
  });

  it('fit frames the view as it first draws, and changes nothing else', () => {
    const { session } = open();
    session.focus(S1);
    session.camera({ x: 30, y: 30, scale: 4 });
    session.fit();
    expect(session.getState().frame).toEqual(INITIAL_FRAME);
    expect(session.getState().focusId).toBe(S1);
    expect(session.getState().historyDepth).toBe(1);
  });
});

describe('a friend’s map session: a new list', () => {
  it('takes the new list and looks, and keeps the camera when its place is still there', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    session.showOverlay('outline');
    session.camera({ x: 5, y: 5, scale: 2 });
    const next = [...DESCRIPTORS];
    const looks = [...LOOKS];
    session.setDescriptors(next, looks);
    expect(session.descriptors()).toBe(next);
    expect(session.getState().looks).toBe(looks);
    expect(session.getState().focusId).toBe(P10);
    expect(session.getState().overlay).toBe('outline');
    expect(session.getState().frame).toEqual({ x: 5, y: 5, scale: 2 });
    expect(session.getState().historyDepth).toBe(2);
    expect(session.getState().notice).toBeUndefined();
  });

  it('clears a pick whose place is gone and keeps one that is still there', () => {
    const { session } = open();
    session.select(P20);
    session.setDescriptors(DESCRIPTORS, LOOKS);
    expect(session.getState().selectedId).toBe(P20);
    session.setDescriptors(without(P20), LOOKS);
    expect(session.getState().selectedId).toBeNull();
  });

  it('when the focused place is gone, returns to the whole map with the notice, and forgets every Back step', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(S2);
    session.focus(P20);
    session.showOverlay('outline');
    session.camera({ x: 8, y: 8, scale: 2 });
    expect(session.getState().historyDepth).toBe(3);
    session.setDescriptors(without(P20), LOOKS);
    const state = session.getState();
    expect(state.focusId).toBeNull();
    expect(state.frame).toEqual(INITIAL_FRAME);
    expect(state.overlay).toBeNull();
    expect(state.notice).toBe('place_unavailable');
    expect(state.historyDepth).toBe(0);
    expect(session.canBack()).toBe(false);
  });

  it('when the focused place is gone, a pick on a place that is still there is kept', () => {
    const { session } = open();
    session.focus(P20);
    session.select(P10);
    session.setDescriptors(without(P20), LOOKS);
    expect(session.getState().focusId).toBeNull();
    expect(session.getState().selectedId).toBe(P10);
  });

  it('lets go of its drawings when a new list comes', () => {
    const { session } = open();
    const held = session.descriptors()[0]!;
    expect(session.geometry(held)).toBeDefined();
    expect(session.cacheSize()).toBe(1);
    session.setDescriptors([...DESCRIPTORS], LOOKS);
    expect(session.cacheSize()).toBe(0);
  });

  it('a descriptor not of the current list has no geometry', () => {
    const { session } = open();
    const held = session.descriptors()[0]!;
    session.setDescriptors(DESCRIPTORS.slice(1), LOOKS);
    expect(session.geometry(held)).toBeUndefined();
    expect(session.cacheSize()).toBe(0);
  });
});

describe('a friend’s map session: drawing detail and geometry', () => {
  it('configure changes detail and motion and clears the drawings, and does nothing when nothing changed', () => {
    const { session } = open();
    const heard = jest.fn();
    session.subscribe(heard);
    session.geometry(session.descriptors()[0]!);
    expect(session.cacheSize()).toBe(1);
    session.configure({ detail: 'full', reducedMotion: true });
    expect(heard).not.toHaveBeenCalled();
    expect(session.cacheSize()).toBe(1);
    session.configure({ detail: 'low', reducedMotion: false });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(session.getState().detail).toBe('low');
    expect(session.getState().reducedMotion).toBe(false);
    expect(session.cacheSize()).toBe(0);
  });

  it('setSimple switches between low and full detail on this screen and remembers nothing', () => {
    const { session } = open();
    session.setSimple(true);
    expect(session.getState().detail).toBe('low');
    session.setSimple(false);
    expect(session.getState().detail).toBe('full');
  });

  it('geometry is served for a place of the list, cached, and drawn low when asked', () => {
    const { session } = open();
    const place = session.descriptors()[0]!;
    const full = session.geometry(place);
    expect(full).toBeDefined();
    expect(session.geometry(place)).toBe(full);
    expect(session.cacheSize()).toBe(1);
    // One drawing is kept per place: the low one replaces the full one.
    expect(session.geometry(place, true)).not.toBe(full);
    expect(session.cacheSize()).toBe(1);
    session.geometry(session.descriptors()[1]!);
    expect(session.cacheSize()).toBe(2);
  });
});

describe('a friend’s map session: the members a friend’s map does not have', () => {
  it('land, focusLast, travel and openRegion all answer false and change nothing', () => {
    const { session } = open();
    session.focus(P10);
    const before = session.getState();
    const heard = jest.fn();
    session.subscribe(heard);
    expect(session.land()).toBe(false);
    expect(session.focusLast()).toBe(false);
    expect(session.travel(id(8000))).toBe(false);
    expect(session.openRegion({} as AvailableRegionPreview, jest.fn())).toBe(false);
    expect(session.openRegion({} as AvailableRegionPreview, jest.fn(), 'alternate')).toBe(false);
    expect(session.getState()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
  });

  it('finds, landmarks, region preview, detail, kept systems, Lately and zoom ceiling do nothing', () => {
    const { session } = open();
    const before = session.getState();
    const heard = jest.fn();
    session.subscribe(heard);
    session.showFinds(S1);
    session.seeLandmark('landmark');
    session.refreshRegionPreview();
    session.setDetail([S1]);
    session.keepSystems([S1]);
    session.setLately(true);
    session.setZoomMax(400);
    expect(session.getState()).toBe(before);
    expect(session.getState().lately).toBe(false);
    expect(session.getState().findsFor).toBeNull();
    expect(session.getState().seenLandmark).toBeNull();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('a friend’s map session: listeners', () => {
  it('tells listeners after each change, once each, until they unsubscribe', () => {
    const { session } = open();
    const heard = jest.fn();
    const off = session.subscribe(heard);
    session.focus(S1);
    expect(heard).toHaveBeenCalledTimes(1);
    session.select(P10);
    session.showOverlay('search');
    session.camera({ x: 1, y: 1, scale: 1 });
    session.fit();
    session.back();
    session.up();
    session.setDescriptors(DESCRIPTORS, LOOKS);
    expect(heard).toHaveBeenCalledTimes(8);
    off();
    session.focus(S2);
    expect(heard).toHaveBeenCalledTimes(8);
  });

  it('gives each change a new state object, with the history depth up to date', () => {
    const { session } = open();
    const seen: unknown[] = [];
    session.subscribe(() => seen.push(session.getState()));
    session.focus(S1);
    session.focus(P10);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect((seen[0] as { historyDepth: number }).historyDepth).toBe(1);
    expect((seen[1] as { historyDepth: number }).historyDepth).toBe(2);
  });

  it('a listener that unsubscribes another during a change does not stop that other being told this time', () => {
    const { session } = open();
    const second = jest.fn();
    let offSecond = () => {};
    session.subscribe(() => offSecond());
    offSecond = session.subscribe(second);
    session.focus(S1);
    expect(second).toHaveBeenCalledTimes(1);
    session.focus(S2);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('a friend’s map session: the transition gate', () => {
  it('taps are ignored while an animation plays', () => {
    const { session } = open();
    session.focus(S1);
    const finish = jest.fn();
    session.gate.set(finish);
    expect(session.gate.active()).toBe(true);
    const before = session.getState();
    expect(session.focus(S2)).toBe(false);
    expect(session.focusLast()).toBe(false);
    expect(session.travel(id(8000))).toBe(false);
    expect(session.land()).toBe(false);
    session.select(P10);
    session.showOverlay('outline');
    session.camera({ x: 5, y: 5, scale: 2 });
    session.fit();
    session.setLately(true);
    expect(session.openRegion({} as AvailableRegionPreview, jest.fn())).toBe(false);
    expect(session.getState()).toBe(before);
    expect(finish).not.toHaveBeenCalled();
  });

  it('Back, Up and Escape jump the animation to its end, then go back as normal', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    const finish = jest.fn();
    session.gate.set(finish);
    expect(session.back()).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(session.getState().focusId).toBe(S1);
    expect(session.up()).toBe(true);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(session.getState().focusId).toBeNull();
    session.gate.set(finish);
    session.focus(S1);
    expect(session.getState().focusId).toBeNull();
    session.gate.set(undefined);
    session.focus(S1);
    session.gate.set(finish);
    expect(session.escape()).toBe(true);
    expect(finish).toHaveBeenCalledTimes(3);
    expect(session.getState().focusId).toBeNull();
  });

  it('input is taken again once the animation has ended', () => {
    const { session } = open();
    session.gate.set(() => {});
    expect(session.focus(S1)).toBe(false);
    session.gate.set(undefined);
    expect(session.gate.active()).toBe(false);
    expect(session.focus(S1)).toBe(true);
  });
});

describe('a friend’s map session: ending it', () => {
  it('ends with nothing left: no places, no geometry, no steps, and a read that has ended', () => {
    const { session } = open();
    session.focus(S1);
    session.focus(P10);
    session.showOverlay('outline');
    const held = session.descriptors()[0]!;
    session.geometry(held);
    session.end();
    expect(session.places()).toEqual([]);
    expect(session.descriptors()).toEqual([]);
    expect(session.cacheSize()).toBe(0);
    expect(session.geometry(held)).toBeUndefined();
    const state = session.getState();
    expect(state.read).toEqual({ status: 'ended', active: false });
    expect(state.focusId).toBeNull();
    expect(state.selectedId).toBeNull();
    expect(state.overlay).toBeNull();
    expect(session.canBack()).toBe(false);
    expect(session.back()).toBe(false);
    expect(session.focus(S1)).toBe(false);
    expect(session.up()).toBe(false);
    expect(session.escape()).toBe(false);
  });

  it('ending does not tell the listeners, and the state keeps the history depth it had', () => {
    const { session } = open();
    session.focus(S1);
    const heard = jest.fn();
    session.subscribe(heard);
    session.end();
    expect(heard).not.toHaveBeenCalled();
    expect(session.getState().historyDepth).toBe(1);
  });

  it('after it has ended, subscribing returns a no-op, and a new list, drawing choices and the screen’s Refresh are refused', async () => {
    const { session, refresh } = open();
    session.end();
    const heard = jest.fn();
    const off = session.subscribe(heard);
    expect(typeof off).toBe('function');
    off();
    session.setDescriptors(DESCRIPTORS, LOOKS);
    session.setForeground(true);
    session.configure({ detail: 'low', reducedMotion: false });
    session.setSimple(true);
    session.camera({ x: 1, y: 1, scale: 2 });
    session.select(S1);
    session.showOverlay('outline');
    await session.refresh();
    expect(heard).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(session.places()).toEqual([]);
    expect(session.getState().read.status).toBe('ended');
    expect(session.getState().detail).toBe('full');
    expect(session.getState().overlay).toBeNull();
  });

  it('ending twice is harmless', () => {
    const { session } = open();
    session.end();
    const state = session.getState();
    session.end();
    expect(session.getState()).toBe(state);
  });
});
