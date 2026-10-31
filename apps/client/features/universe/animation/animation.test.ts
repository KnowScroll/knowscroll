import { FIELD_OF_VIEW, rigPose, type CameraPose } from '../space/camera-rig';
import type { FrameScheduler } from '../space/render-loop';
import { clamp01, easeOut, logLerp, smootherstep, smoothstep } from './easing';
import { cameraAt as enterPlanetCameraAt, ENTER_PLANET, finalFraming, globeAt, handoverAt } from './enter-planet';
import { ENTER_SYSTEM, enterSystemFrame } from './enter-system';
import { ENTER_WORLD, enterWorldFrame } from './enter-world';
import { END_POSITION, FIRST_OPEN, distanceAt, firstOpenFrame, speedAt, warpAt } from './first-open-timeline';
import { createAnimationPlayer, type AnimationEnd, type AnimationKind } from './player';
import { createTransitionGate, withTransitionGate } from './transition-gate';
import { cameraBasis, dot, length, sub, type Vec3 } from './vec3';

/** A scheduler the test drives by hand, one frame stamp at a time (the stamps are the ones rAF would give). */
function manualScheduler() {
  let pending: ((nowMs: number) => void) | null = null;
  const scheduler: FrameScheduler = {
    request(callback) {
      pending = callback;
      return 1;
    },
    cancel() {
      pending = null;
    },
  };
  return {
    scheduler,
    pending: () => pending !== null,
    run(nowMs: number) {
      const callback = pending;
      pending = null;
      callback?.(nowMs);
    },
  };
}

describe('the easing rules', () => {
  it('start and stop smoothly and never overshoot', () => {
    for (const curve of [smootherstep, easeOut, (x: number) => smoothstep(0, 1, x)]) {
      expect(curve(0)).toBe(0);
      expect(curve(1)).toBe(1);
      expect(curve(-3)).toBe(0);
      expect(curve(4)).toBe(1);
      let last = 0;
      for (let step = 1; step <= 20; step += 1) {
        const now = curve(step / 20);
        expect(now).toBeGreaterThanOrEqual(last);
        last = now;
      }
    }
    expect(logLerp(100, 1, 0.5)).toBeCloseTo(10, 6);
    expect(clamp01(2)).toBe(1);
  });
});

describe('the animation player', () => {
  const play = (seconds = 1) => {
    const frames = manualScheduler();
    const player = createAnimationPlayer(frames.scheduler);
    const seen: number[] = [];
    const ends: [AnimationKind, AnimationEnd][] = [];
    player.subscribe((run) => seen.push(run.t));
    player.onEnd((kind, how) => ends.push([kind, how]));
    player.start('enter-system', seconds);
    return { frames, player, seen, ends };
  };

  it('draws the first stamp at t = 0 and advances t by the time between accepted stamps', () => {
    const { frames, seen } = play(5);
    frames.run(5_000);
    frames.run(5_033);
    frames.run(5_066);
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeCloseTo(0.033, 3);
    expect(seen[2]).toBeCloseTo(0.066, 3);
  });

  it('accepts a frame at most every 33 ms: a 60 Hz display is held to about 30 fps', () => {
    const { frames, seen } = play(30);
    let stamp = 10_000;
    for (let frame = 0; frame < 120; frame += 1) {
      frames.run(stamp);
      stamp += 1000 / 60;
    }
    // Two seconds of 60 Hz stamps draw about 60 frames, never 120.
    expect(seen.length).toBeGreaterThan(55);
    expect(seen.length).toBeLessThanOrEqual(62);
    const gaps = seen.slice(1).map((time, at) => time - seen[at]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.032);
  });

  it('clamps one frame to 0.1 s, so a stall never jumps the story', () => {
    const { frames, seen } = play(30);
    frames.run(1_000);
    frames.run(1_033);
    frames.run(61_000);
    expect(seen[2]! - seen[1]!).toBeCloseTo(0.1, 6);
  });

  it('finishes exactly on its last frame, then asks for nothing more', () => {
    const { frames, seen, ends, player } = play(0.2);
    for (let stamp = 0; stamp < 600; stamp += 34) frames.run(stamp);
    expect(seen.at(-1)).toBe(0.2);
    expect(ends).toEqual([['enter-system', 'finished']]);
    expect(frames.pending()).toBe(false);
    expect(player.current()).toBeUndefined();
  });

  it('jumps to the end frame on finish (Skip, or Back while it plays) and says it was skipped', () => {
    const { frames, seen, ends, player } = play(5);
    frames.run(0);
    frames.run(40);
    player.finish();
    expect(seen.at(-1)).toBe(5);
    expect(ends).toEqual([['enter-system', 'skipped']]);
    expect(frames.pending()).toBe(false);
    player.finish();
    expect(ends).toHaveLength(1);
  });

  it('does not end twice when a listener asks for the end on the last frame', () => {
    const { frames, player, ends } = play(0.2);
    player.subscribe((run) => {
      if (run.t >= 0.2) player.finish();
    });
    for (let stamp = 0; stamp < 600; stamp += 34) frames.run(stamp);
    expect(ends).toHaveLength(1);
  });

  it('plays nothing after it is disposed', () => {
    const { frames, seen, player } = play(5);
    player.dispose();
    frames.run(0);
    expect(seen).toEqual([]);
    expect(frames.pending()).toBe(false);
  });
});

describe('the transition gate', () => {
  it('is active only while a finisher is registered, and finishing runs it', () => {
    const gate = createTransitionGate();
    expect(gate.active()).toBe(false);
    expect(gate.finish()).toBe(false);
    const finisher = jest.fn();
    gate.set(finisher);
    expect(gate.active()).toBe(true);
    expect(gate.finish()).toBe(true);
    expect(finisher).toHaveBeenCalledTimes(1);
    gate.set(undefined);
    expect(gate.active()).toBe(false);
  });
});

describe('a session behind the gate', () => {
  const session = () => {
    const calls: string[] = [];
    const record = (name: string) => () => {
      calls.push(name);
      return true;
    };
    return {
      calls,
      session: withTransitionGate({
        focus: record('focus'),
        land: record('land'),
        select: record('select'),
        camera: record('camera'),
        back: record('back'),
        up: record('up'),
        escape: record('escape'),
        getState: () => 'state',
      }),
    };
  };

  it('passes everything through while nothing plays', () => {
    const { calls, session: gated } = session();
    gated.focus();
    gated.land();
    gated.back();
    expect(calls).toEqual(['focus', 'land', 'back']);
  });

  it('ignores taps while one plays, and Back, Up and Escape jump it to its end first and then go back', () => {
    const { calls, session: gated } = session();
    const finished = jest.fn(() => gated.gate.set(undefined));
    gated.gate.set(finished);
    expect(gated.focus()).toBe(false);
    expect(gated.land()).toBe(false);
    expect(gated.select()).toBe(false);
    expect(gated.camera()).toBe(false);
    expect(calls).toEqual([]);
    expect(gated.back()).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['back']);
    // It ended, so taps work again.
    expect(gated.focus()).toBe(true);
  });
});

/** A perspective projection of a sphere's centre and radius, in pixels, for a camera pose. */
function project(pose: CameraPose, point: Vec3, radius: number, width: number, height: number) {
  const { right, up, back } = cameraBasis(pose.position, pose.target);
  const offset = sub(point, pose.position);
  const depth = -dot(offset, back);
  const tan = Math.tan((pose.fov / 2) * (Math.PI / 180));
  const half = height / 2;
  const centre = {
    x: width / 2 + (dot(offset, right) / (depth * tan)) * half,
    y: height / 2 - (dot(offset, up) / (depth * tan)) * half,
  };
  return { ...centre, radius: (Math.tan(Math.asin(radius / length(offset))) / tan) * half };
}

const systemPose: CameraPose = rigPose({
  focus: { kind: 'system', systemId: 's', center: { x: 0, z: 0 }, radius: 7 },
  frame: { x: 0, y: 0, scale: 1 },
  width: 390,
  height: 844,
});
const universePose: CameraPose = rigPose({
  focus: { kind: 'universe', center: { x: 0, z: 0 }, halfWidth: 12, halfDepth: 12 },
  frame: { x: 0, y: 0, scale: 1 },
  width: 390,
  height: 844,
});

describe('entering a system', () => {
  const scene = { from: universePose, to: systemPose, sun: [0, 0, 0] as Vec3, dock: [1.2, 0.2, 2.5] as Vec3 };

  it('starts on the overview camera and ends on the system camera, to the pixel', () => {
    const first = enterSystemFrame(0, scene);
    const last = enterSystemFrame(ENTER_SYSTEM.seconds, scene);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(first.pose.position[axis]).toBeCloseTo(universePose.position[axis]!, 6);
      expect(last.pose.position[axis]).toBeCloseTo(systemPose.position[axis]!, 6);
      expect(last.pose.target[axis]).toBeCloseTo(systemPose.target[axis]!, 6);
    }
    expect(first.pose.fov).toBe(FIELD_OF_VIEW);
    expect(last.pose.fov).toBe(FIELD_OF_VIEW);
  });

  it('has no rocket on the first frame and none on the last: the parked ship has taken over', () => {
    expect(enterSystemFrame(0, scene).rocket.visible).toBe(false);
    expect(enterSystemFrame(1.2, scene).rocket.visible).toBe(true);
    const last = enterSystemFrame(ENTER_SYSTEM.seconds, scene);
    expect(last.rocket.visible).toBe(false);
    expect(last.parkedShip).toBe(1);
    expect(enterSystemFrame(0, scene).parkedShip).toBe(0);
  });

  it('parks the rocket on the dock', () => {
    const parked = enterSystemFrame(ENTER_SYSTEM.parked, scene).rocket.position;
    expect(length(sub(parked, scene.dock))).toBeLessThan(1e-6);
  });

  it('raises the system’s chrome last, one piece after another', () => {
    const first = enterSystemFrame(0, scene).chrome;
    const last = enterSystemFrame(ENTER_SYSTEM.seconds, scene).chrome;
    expect(first.overviewOpacity).toBe(1);
    expect(first.title.opacity).toBe(0);
    expect(last.overviewOpacity).toBe(0);
    expect([last.back.opacity, last.title.opacity, last.bottom.opacity, last.labelsOpacity]).toEqual([1, 1, 1, 1]);
    expect([last.back.offset, last.title.offset, last.bottom.offset]).toEqual([0, 0, 0]);
    expect(enterSystemFrame(3, scene).chrome.title.opacity).toBe(0);
    // Back first, then the title, then the bottom actions, 0.1 s apart.
    const rising = enterSystemFrame(4.7, scene).chrome;
    expect(rising.back.opacity).toBeGreaterThan(rising.title.opacity);
    expect(rising.title.opacity).toBeGreaterThan(rising.bottom.opacity);
  });

  it('is a pure function of t: the same t gives the same frame', () => {
    expect(enterSystemFrame(2.7, scene)).toEqual(enterSystemFrame(2.7, scene));
  });

  it('shows one tap ring that opens and fades inside 0.6 s', () => {
    expect(enterSystemFrame(0, scene).chrome.tapRing.opacity).toBeCloseTo(0.9, 6);
    expect(enterSystemFrame(0.3, scene).chrome.tapRing.scale).toBeGreaterThan(2);
    expect(enterSystemFrame(0.6, scene).chrome.tapRing.opacity).toBe(0);
  });
});

describe('entering a planet', () => {
  const screen = { width: 390, height: 844 };
  const globe = { x: 195, y: 372, radius: 146 };

  it('uses the design’s own framing at 390 by 844: 8.455 radii out, looking 0.0408 of that below the centre', () => {
    const framing = finalFraming(1, screen, globe);
    expect(framing.distance).toBeCloseTo(8.455, 2);
    expect(framing.lookBelow / framing.distance).toBeCloseTo(0.0408, 3);
  });

  it('ends with the 3D planet exactly where the globe is drawn, at any phone or window size', () => {
    for (const size of [
      { screen, globe },
      { screen: { width: 360, height: 640 }, globe: { x: 180, y: 281.6, radius: 130 } },
      { screen: { width: 1100, height: 900 }, globe: { x: 550, y: 396, radius: 162 } },
    ]) {
      const planet: Vec3 = [3.1, 0.2, -1.4];
      const radius = 0.3;
      const scene = {
        from: systemPose,
        planet,
        planetRadius: radius,
        sun: [0, 0, 0] as Vec3,
        screen: size.screen,
        globe: size.globe,
      };
      const pose = enterPlanetCameraAt(ENTER_PLANET.glideEnd, scene);
      const at = project(pose, planet, radius, size.screen.width, size.screen.height);
      expect(at.x).toBeCloseTo(size.globe.x, 0);
      expect(at.y).toBeCloseTo(size.globe.y, 0);
      expect(at.radius).toBeCloseTo(size.globe.radius, 0);
      expect(pose.fov).toBe(FIELD_OF_VIEW);
    }
  });

  it('starts on the system camera', () => {
    const scene = {
      from: systemPose,
      planet: [3, 0, 1] as Vec3,
      planetRadius: 0.3,
      sun: [0, 0, 0] as Vec3,
      screen,
      globe,
    };
    const pose = enterPlanetCameraAt(0, scene);
    for (let axis = 0; axis < 3; axis += 1) expect(pose.position[axis]).toBeCloseTo(systemPose.position[axis]!, 6);
  });

  it('brings the globe in from blurred to sharp as the camera nears, and the starfield last', () => {
    const early = globeAt(0.6, 20, 2.5);
    const late = globeAt(ENTER_PLANET.glideEnd, 2.5, 2.5);
    expect(early.opacity).toBeLessThan(late.opacity);
    expect(late.opacity).toBe(1);
    expect(late.blur).toBe(0);
    expect(early.blur).toBeGreaterThan(0);
    expect(globeAt(1, 20, 2.5).stars).toBe(0);
    expect(late.stars).toBe(1);
    expect(late.atmosphere).toBeCloseTo(0.32, 2);
    expect(globeAt(0, 40, 2.5).atmosphere).toBeCloseTo(1.15, 2);
    expect(globeAt(0, 40, 2.5).shipScale).toBe(1);
    expect(globeAt(1, 20, 2.5).shipScale).toBe(0);
  });

  it('turns a 3D ring and moon into the planet view’s before it lets them go', () => {
    const start = handoverAt(0);
    const middle = handoverAt(1.7);
    const end = handoverAt(ENTER_PLANET.seconds);
    expect([start.inner, start.outer, start.fade]).toEqual([1.4, 2.4, 1]);
    expect(middle.outer).toBeLessThan(start.outer);
    expect(end.weight).toBe(1);
    expect(end.inner).toBeCloseTo(1.42, 6);
    expect(end.outer).toBeCloseTo(1.56, 6);
    expect(end.moonWeight).toBe(1);
    expect(end.fade).toBe(0);
    // They only fade once they match.
    expect(handoverAt(2.55).weight).toBeGreaterThan(0.95);
    expect(handoverAt(2.55).fade).toBe(1);
  });
});

describe('entering a world', () => {
  const screen = { width: 390, height: 844 };
  const globe = { x: 195, y: 372, radius: 146 };

  it('starts on the globe and ends on the live map, filling the screen', () => {
    const first = enterWorldFrame(0, { screen, globe });
    expect(first.globeScale).toBe(1);
    expect(first.globeOpacity).toBe(1);
    expect(first.circle).toEqual({ x: 195, y: 372, radius: 146 });
    expect(first.map.opacity).toBe(0);
    const last = enterWorldFrame(ENTER_WORLD.seconds, { screen, globe });
    expect(last.circle.radius).toBeGreaterThanOrEqual(Math.hypot(195, 422));
    expect(last.map).toEqual({ opacity: 1, scale: 1, shiftX: 0, shiftY: 0 });
    expect([last.liveMap, last.names, last.clouds, last.globeOpacity, last.shading]).toEqual([1, 1, 1, 0, 0]);
  });

  it('leans in, then opens out, each in its own beat', () => {
    expect(enterWorldFrame(1.1, { screen, globe }).globeScale).toBeCloseTo(1.32, 6);
    const small = enterWorldFrame(1.0, { screen, globe }).circle.radius;
    const large = enterWorldFrame(2.0, { screen, globe }).circle.radius;
    expect(large).toBeGreaterThan(small * 1.5);
    let last = 0;
    for (let step = 0; step <= 32; step += 1) {
      const radius = enterWorldFrame(step / 10, { screen, globe }).circle.radius;
      expect(radius).toBeGreaterThanOrEqual(last - 1e-9);
      last = radius;
    }
  });
});

describe('the first open', () => {
  it('ends exactly on U01 Empty’s camera, at rest', () => {
    const last = firstOpenFrame(FIRST_OPEN.seconds);
    for (let axis = 0; axis < 3; axis += 1) expect(last.camera.position[axis]).toBeCloseTo(END_POSITION[axis]!, 3);
    expect(last.camera.fov).toBeCloseTo(FIELD_OF_VIEW, 6);
    expect(last.camera.roll).toBeCloseTo(0, 6);
    expect(distanceAt(FIRST_OPEN.arrive)).toBeCloseTo(FIRST_OPEN.distance, 3);
    expect(speedAt(FIRST_OPEN.arrive)).toBe(0);
    expect(warpAt(FIRST_OPEN.arrive)).toBe(0);
  });

  it('builds the star from the dust, trembles, bursts, then travels and slows to a stop', () => {
    expect(firstOpenFrame(0.5).star.visible).toBe(false);
    expect(firstOpenFrame(3).star.visible).toBe(true);
    expect(firstOpenFrame(3).star.size).toBeLessThan(firstOpenFrame(5).star.size);
    expect(firstOpenFrame(5.5).star.heat).toBeGreaterThan(0);
    expect(firstOpenFrame(FIRST_OPEN.bang + 0.3).star.visible).toBe(false);
    expect(firstOpenFrame(FIRST_OPEN.bang).flash).toBeGreaterThan(0.5);
    expect(firstOpenFrame(10).flash).toBe(0);
    expect(speedAt(10)).toBeGreaterThan(0);
    expect(warpAt(FIRST_OPEN.full)).toBeGreaterThan(0.9);
    let last = -1;
    for (let step = 0; step <= 400; step += 1) {
      const along = distanceAt((step / 400) * FIRST_OPEN.arrive);
      expect(along).toBeGreaterThanOrEqual(last);
      last = along;
    }
  });

  it('keeps Skip until just before arrival, and raises the empty state last', () => {
    expect(firstOpenFrame(0).skip).toBe(1);
    expect(firstOpenFrame(FIRST_OPEN.arrive).skip).toBe(0);
    expect(firstOpenFrame(10).empty.title.opacity).toBe(0);
    const end = firstOpenFrame(FIRST_OPEN.seconds).empty;
    expect([end.header.opacity, end.title.opacity, end.line.opacity, end.action.opacity]).toEqual([1, 1, 1, 1]);
  });
});
