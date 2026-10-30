import {
  AXIAL_TILT_DEGREES,
  INITIAL_STAGE_STATE,
  STAGE_ENUMS,
  settleStageState,
  stagePhysics,
  type StageState,
} from '@knowscroll/scroll-model';
import {
  axisDirection,
  beamFootprint,
  canTween,
  footprintLength,
  lerpScene,
  onCircle,
  pinPoint,
  sceneOf,
} from './earth-sky-scene';

const state = (patch: Partial<StageState>): StageState => settleStageState({ ...INITIAL_STAGE_STATE, ...patch });

/**
 * How far the drawn axis leans toward the Sun in an orbit seen from above, as a share of the full
 * tilt: the axis' sideways turn against the direction from Earth to the Sun, from the picture alone.
 */
function drawnLean(month: StageState['earthAt']): number {
  const scene = sceneOf(state({ view: 'orbit', earthAt: month }));
  const earth = onCircle({ x: 0, y: 0 }, 1, scene.earthAngle);
  const towardSun = { x: -earth.x, y: -earth.y };
  const lean = (axisDirection(scene.axisTurn).x * towardSun.x) / Math.sin((AXIAL_TILT_DEGREES * Math.PI) / 180);
  return Math.round(lean * 1e6) / 1e6;
}

describe('the picture agrees with the physics the scroll-model derives', () => {
  it.each(STAGE_ENUMS.earthAt)(
    '%s: the half that leans in the orbit picture is the half stagePhysics names',
    (month) => {
      const lean = drawnLean(month);
      const drawn = lean >= 0.5 ? 'north' : lean <= -0.5 ? 'south' : 'neither';
      expect(drawn).toBe(stagePhysics({ earthAt: month }).leansToward);
    },
  );

  it('draws the same axis in every month of an orbit view', () => {
    const turns = new Set(
      STAGE_ENUMS.earthAt.map((month) => sceneOf(state({ view: 'orbit', earthAt: month })).axisTurn),
    );
    expect([...turns]).toEqual([-AXIAL_TILT_DEGREES]);
  });

  it.each(STAGE_ENUMS.earthAt)(
    '%s: the side view leans the axis toward the Sun exactly when the north does',
    (month) => {
      const turn = sceneOf(state({ view: 'sun-earth', earthAt: month })).axisTurn;
      const leans = stagePhysics({ earthAt: month }).leansToward;
      expect(Math.sign(turn)).toBe(leans === 'north' ? -1 : leans === 'south' ? 1 : 0);
    },
  );

  it.each(STAGE_ENUMS.earthAt)('%s: a higher Sun covers less ground and warms its pin more', (month) => {
    const scene = sceneOf(state({ view: 'earth-close', earthAt: month }));
    const centre = { x: 0, y: 0 };
    const ground = (hemisphere: 'north' | 'south', away: number): number => {
      const pin = pinPoint(centre, 100, hemisphere, away);
      return footprintLength(beamFootprint(centre, 100, pin));
    };
    const physics = stagePhysics({ earthAt: month });
    const higher = physics.north.sunHeight === 'high' ? 'north' : physics.south.sunHeight === 'high' ? 'south' : null;
    if (higher === null) return;
    const lower = higher === 'north' ? 'south' : 'north';
    const away = (hemisphere: 'north' | 'south') => (hemisphere === 'north' ? scene.northPinAway : scene.southPinAway);
    expect(ground(higher, away(higher))).toBeLessThan(ground(lower, away(lower)));
    const warmth = (hemisphere: 'north' | 'south') => (hemisphere === 'north' ? scene.northWarmth : scene.southWarmth);
    expect(warmth(higher)).toBeGreaterThan(warmth(lower));
  });
});

describe('moving between scenes', () => {
  it('tweens a month change inside a view and between the two orbit views, and replaces anything else', () => {
    const june = sceneOf(state({ view: 'orbit', earthAt: 'jun' }));
    expect(canTween(june, sceneOf(state({ view: 'orbit', earthAt: 'dec' })))).toBe(true);
    expect(canTween(june, sceneOf(state({ view: 'orbit-stretched', earthAt: 'jan' })))).toBe(true);
    expect(canTween(june, sceneOf(state({ view: 'earth-close', earthAt: 'jun' })))).toBe(false);
  });

  it('takes the short way round the orbit, from December across January', () => {
    const from = sceneOf(state({ view: 'orbit', earthAt: 'dec' }));
    const to = sceneOf(state({ view: 'orbit', earthAt: 'feb' }));
    const middle = lerpScene(from, to, 0.5).earthAngle;
    // December (180) to February (240 round the circle): the middle is January's side, 210.
    expect(((middle % 360) + 360) % 360).toBeCloseTo(210, 6);
  });

  it('ends exactly on the target scene', () => {
    const from = sceneOf(state({ view: 'earth-close', earthAt: 'jun', focus: 'ray' }));
    const to = sceneOf(state({ view: 'earth-close', earthAt: 'dec', focus: 'south-pin' }));
    expect(lerpScene(from, to, 1)).toEqual(to);
    expect(lerpScene(from, to, 0)).toEqual(from);
  });
});
