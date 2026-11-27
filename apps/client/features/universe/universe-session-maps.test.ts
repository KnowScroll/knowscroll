import { waitFor } from '@testing-library/react-native';
import { createUniverseViewSession } from './universe-session';
import { saveUniverseMemory } from './universe-memory';
import { COLLECTION_READS, fixtureId, universeHarness } from './universe.fixture';

// Authored valid UUIDs replace Expo's native Jest UUID stub; production IDs are unchanged.
jest.mock('../../platform/command-id', () => {
  let next = 30000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});

const PLANET = fixtureId(12);
const SYSTEM = fixtureId(10);
/** The planet's formed regions: CI region 4, then the two the harness adds. */
const REGIONS = [fixtureId(14), fixtureId(100), fixtureId(101)] as const;

type Session = ReturnType<typeof createUniverseViewSession>;
const ready = async (session: Session) => waitFor(() => expect(session.getState().read.status).toBe('ready'));

/** A session in front, over a planet with three formed regions. */
async function opened() {
  const h = universeHarness(5, 0, 2);
  const session = createUniverseViewSession(h.scope);
  session.setForeground(true);
  await ready(session);
  return { h, session };
}

/** The planet's ground: its system, its globe, then landed. */
function onGround(session: Session): void {
  session.focus(SYSTEM);
  session.focus(PLANET);
  session.land();
}

const isRead = (path: string) => path.startsWith('/v1/universe/') || COLLECTION_READS.includes(path);

describe('the planet’s map (the new look)', () => {
  it('opens only over a landed planet or a region, and Back closes it where it was opened', async () => {
    const { h, session } = await opened();
    session.showOverlay('planet-map');
    expect(session.getState().overlay).toBeNull();
    session.focus(SYSTEM);
    session.focus(PLANET);
    // A globe is not ground: its map opens by landing.
    session.showOverlay('planet-map');
    expect(session.getState().overlay).toBeNull();
    session.land();
    const camera = { focusId: PLANET, landed: true, frame: session.getState().frame };
    session.showOverlay('planet-map');
    expect(session.getState()).toMatchObject({ overlay: 'planet-map', ...camera });
    expect(session.canBack()).toBe(true);
    expect(session.back()).toBe(true);
    expect(session.getState()).toMatchObject({ overlay: null, ...camera });
    h.scope.end();
  });

  it('looking at it reads and writes nothing, and the region’s map does only the card’s one preview read', async () => {
    const { h, session } = await opened();
    onGround(session);
    const before = h.calls.length;
    session.showOverlay('planet-map');
    session.back();
    expect(h.calls.slice(before)).toEqual([]);
    expect(h.store.keys().every((key) => key.endsWith('.universe.view.v1'))).toBe(true);
    session.showOverlay('planet-map');
    session.focus(REGIONS[0]);
    await waitFor(() => expect(h.calls.filter((path) => path.endsWith('/region/preview'))).toHaveLength(1));
    expect(h.calls.every((path) => isRead(path) || path === '/v1/experience/region/preview')).toBe(true);
    h.scope.end();
  });

  it('is the planet’s map and then a region’s: Back goes to the map, then to the camera the map was opened from', async () => {
    const { h, session } = await opened();
    onGround(session);
    const ground = session.getState();
    session.showOverlay('planet-map');
    session.focus(REGIONS[0]);
    expect(session.getState()).toMatchObject({ overlay: 'place', focusId: REGIONS[0], mapBehind: true });
    expect(session.getState().historyDepth).toBe(ground.historyDepth + 1);
    expect(session.back()).toBe(true);
    expect(session.getState()).toMatchObject({
      overlay: 'planet-map',
      focusId: PLANET,
      landed: true,
      mapBehind: false,
      historyDepth: ground.historyDepth,
    });
    expect(session.back()).toBe(true);
    expect(session.getState()).toMatchObject({ overlay: null, focusId: PLANET, landed: true });
    // One more Back is the ground's own: the planet's globe, as it was before the map.
    expect(session.back()).toBe(true);
    expect(session.getState()).toMatchObject({ focusId: PLANET, landed: false });
    h.scope.end();
  });

  it('from a region’s ground, a sibling region pushes no step and Back returns to the region the map was opened from', async () => {
    const { h, session } = await opened();
    onGround(session);
    session.focus(REGIONS[0]);
    session.back();
    const ground = session.getState();
    expect(ground).toMatchObject({ focusId: REGIONS[0], overlay: null });
    session.showOverlay('planet-map');
    session.focus(REGIONS[1]);
    // Regions of one planet replace each other: no step was pushed, so none may be popped.
    expect(session.getState()).toMatchObject({ overlay: 'place', focusId: REGIONS[1], mapBehind: true });
    expect(session.getState().historyDepth).toBe(ground.historyDepth);
    session.back();
    expect(session.getState()).toMatchObject({
      overlay: 'planet-map',
      focusId: REGIONS[0],
      historyDepth: ground.historyDepth,
    });
    session.back();
    expect(session.getState()).toMatchObject({ overlay: null, focusId: REGIONS[0], historyDepth: ground.historyDepth });
    h.scope.end();
  });

  it('chooses one region after another from the map, each Back returning to the map', async () => {
    const { h, session } = await opened();
    onGround(session);
    const depth = session.getState().historyDepth;
    session.showOverlay('planet-map');
    session.focus(REGIONS[0]);
    session.back();
    session.focus(REGIONS[2]);
    expect(session.getState()).toMatchObject({ overlay: 'place', focusId: REGIONS[2], mapBehind: true });
    session.back();
    expect(session.getState()).toMatchObject({ overlay: 'planet-map', focusId: PLANET, historyDepth: depth });
    session.back();
    expect(session.getState()).toMatchObject({ overlay: null, focusId: PLANET, historyDepth: depth });
    h.scope.end();
  });

  it('Escape takes the same single steps as Back', async () => {
    const { h, session } = await opened();
    onGround(session);
    session.showOverlay('planet-map');
    session.focus(REGIONS[0]);
    expect(session.escape()).toBe(true);
    expect(session.getState().overlay).toBe('planet-map');
    expect(session.escape()).toBe(true);
    expect(session.getState()).toMatchObject({ overlay: null, focusId: PLANET });
    h.scope.end();
  });

  it('keeps the device’s remembered camera where Back left it', async () => {
    const { h, session } = await opened();
    onGround(session);
    session.showOverlay('planet-map');
    session.focus(REGIONS[0]);
    expect(h.scope.storage.get('universe.view.v1')).toContain(REGIONS[0]);
    session.back();
    expect(h.scope.storage.get('universe.view.v1')).toContain(`"focusId":"${PLANET}"`);
    h.scope.end();
  });

  it('returns to the map from Search or Browse opened over it, and the region’s map from the same', async () => {
    const { h, session } = await opened();
    onGround(session);
    session.showOverlay('planet-map');
    session.showOverlay('search');
    expect(session.getState().overlay).toBe('search');
    session.back();
    expect(session.getState()).toMatchObject({ overlay: 'planet-map', focusId: PLANET });
    session.showOverlay('outline');
    session.back();
    expect(session.getState().overlay).toBe('planet-map');
    session.back();
    expect(session.getState().overlay).toBeNull();
    // Closed, Search covers nothing: Back from it does not bring the map back.
    session.showOverlay('search');
    session.back();
    expect(session.getState().overlay).toBeNull();
    // Over a region's map it returns to that map, which still has the planet's map behind it.
    session.showOverlay('planet-map');
    session.focus(REGIONS[0]);
    session.showOverlay('search');
    session.back();
    expect(session.getState()).toMatchObject({ overlay: 'place', mapBehind: true });
    session.back();
    expect(session.getState().overlay).toBe('planet-map');
    h.scope.end();
  });

  it('a search choice replaces the map instead of leaving one behind', async () => {
    const { h, session } = await opened();
    onGround(session);
    session.showOverlay('planet-map');
    session.showOverlay('search');
    session.focus(REGIONS[1]);
    expect(session.getState()).toMatchObject({ overlay: 'place', mapBehind: false });
    session.back();
    expect(session.getState()).toMatchObject({ overlay: null, focusId: REGIONS[1] });
    h.scope.end();
  });

  it('never shows the overlay empty, nor a Back with nothing to do, between the two halves of a step', async () => {
    // The browser's Back marker is taken off the page when Back has nothing to do: a notice in the middle of a step
    // would take the page back past the Universe. A ground restored from the device has no history at all.
    const h = universeHarness(5, 0, 2);
    saveUniverseMemory(h.scope, {
      focusId: PLANET,
      landed: true,
      frame: { x: 0, y: 0, scale: 1 },
      lately: false,
      simple: false,
      lastPlace: { id: PLANET, label: 'CI planet 2', kind: 'planet' },
      seenAt: Date.now(),
    });
    const session = createUniverseViewSession(h.scope);
    session.setForeground(true);
    await ready(session);
    expect(session.getState()).toMatchObject({ focusId: PLANET, landed: true, historyDepth: 0 });
    const seen: { overlay: string | null; canBack: boolean }[] = [];
    session.showOverlay('planet-map');
    // Opened by now: a reader's late notice before this would be nothing to do with the steps below.
    session.subscribe(() => seen.push({ overlay: session.getState().overlay, canBack: session.canBack() }));
    session.focus(REGIONS[0]);
    session.back();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((notice) => notice.overlay !== null && notice.canBack)).toBe(true);
    expect(session.getState().overlay).toBe('planet-map');
    h.scope.end();
  });

  it('refuses to open anywhere it was not made for', async () => {
    const { h, session } = await opened();
    session.focus(SYSTEM);
    session.showOverlay('planet-map');
    expect(session.getState().overlay).toBeNull();
    session.setForeground(false);
    session.focus(PLANET);
    h.scope.end();
  });
});

describe('with the new look off, the shared paths are as they were', () => {
  it('a region chosen from the ground is a card, Back from it leaves the region, and no map state is ever set', async () => {
    const { h, session } = await opened();
    onGround(session);
    const seen: (string | null)[] = [];
    session.subscribe(() => seen.push(session.getState().overlay));
    const depth = session.getState().historyDepth;
    session.focus(REGIONS[0]);
    expect(session.getState()).toMatchObject({ overlay: 'place', focusId: REGIONS[0], mapBehind: false });
    expect(session.getState().historyDepth).toBe(depth + 1);
    expect(seen).toContain(null);
    expect(session.back()).toBe(true);
    expect(session.getState()).toMatchObject({ overlay: null, focusId: REGIONS[0], historyDepth: depth + 1 });
    // The next Back is the history's: the planet's ground, as ever.
    expect(session.back()).toBe(true);
    expect(session.getState()).toMatchObject({ overlay: null, focusId: PLANET, landed: true });
    h.scope.end();
  });

  it('Search or Browse over the card returns to the card, and over nothing returns to nothing', async () => {
    const { h, session } = await opened();
    onGround(session);
    session.focus(REGIONS[0]);
    session.showOverlay('search');
    session.back();
    expect(session.getState().overlay).toBe('place');
    session.back();
    session.showOverlay('search');
    session.back();
    expect(session.getState().overlay).toBeNull();
    h.scope.end();
  });
});
