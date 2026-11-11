import * as THREE from 'three';
import {
  flyDone,
  flyPose,
  FLY_SECONDS,
  isFar as isFarPose,
  rigPose,
  withDrift,
  type CameraPose,
  type RigFocus,
  type RigSpec,
} from './camera-rig';
import { ENTER_SYSTEM } from '../animation/enter-system';
import { chooseDetail, DETAIL_BUILDS_PER_FRAME, drawsEverything, sameSet } from './detail-set';
import { buildSpace, type BuiltSpace } from './scene/build-scene';
import { projectAnchors, type AnchorScratch } from './space-anchors';
import type { PaintCache } from './scene/context';
import { directFrame, endScript, type DirectedFrame, type Projection } from './script-director';
import type { SpaceDefinition } from './space-definition';
import type { SpaceScript } from './space-script';
import type { SpaceAnchor, SpaceProbe, SpaceSurface } from './space-surface';

/** What the person's camera looks at and how far they have panned and zoomed. The renderer adds the size. */
export type SpaceCameraSpec = Omit<RigSpec, 'width' | 'height'>;

/** What a renderer may be told beyond its surface and its first definition. */
export interface SpaceRendererOptions {
  /**
   * Called with the systems the drawing wants in full whenever that set changes (D-417), for a map with more systems
   * than {@link DETAIL_MAX}: the screen loads their planets. Never called for a map small enough to draw whole.
   */
  readonly onDetail?: (systemIds: readonly string[]) => void;
  /** Systems built in full in one frame. Absent: {@link DETAIL_BUILDS_PER_FRAME}; a still frame (reduced motion) builds all at once. */
  readonly buildsPerFrame?: number;
}

/** The drawing of one space view on one surface. */
export interface SpaceRenderer {
  /** Poses the scene at `t`, draws it and presents it. */
  draw(t: number): void;
  /** Layout size changed (a rotation or a window resize). */
  resize(width: number, height: number): void;
  /**
   * Replaces what is drawn (a place formed, Lately was switched, the ship moved). The camera, the
   * highlight and the pose in flight are kept.
   */
  setDefinition(definition: SpaceDefinition): void;
  /**
   * Aims the camera. When the focus changes (the whole universe to a system and back) and `animate` is
   * true, the camera flies there: 2.4 s going in, 0.3 s coming out. Otherwise it jumps.
   */
  setCamera(spec: SpaceCameraSpec, animate: boolean): void;
  /**
   * Hands the camera to an animation ("Enter a system", "Enter a planet") until it is cleared with `null`. The
   * script's clock decides every frame; clearing it puts the scene back as the live view has it. Call it
   * before `setCamera` when the camera's focus changes with the animation (entering a system).
   */
  setScript(script: SpaceScript | null): void;
  /** Glows around one system (the one picked on the Far level), or none. */
  setHighlight(systemId: string | null): void;
  /** The named points of the scene in layout pixels, for the labels and tap targets drawn over the canvas. */
  anchors(): SpaceAnchor[];
  /** Whether the universe is far enough away to read as the Far level (U08) at the last frame. */
  isFar(): boolean;
  /** Reads a coarse sample of the last frame. Call right after `draw`, before the next frame. */
  probe(): SpaceProbe;
  /**
   * Releases the GPU resources. The surface itself belongs to its host. `releaseContext` also asks
   * the browser to free the WebGL context at once (the view is going away for good); it is ignored
   * on native, where the `GLView` owns its context.
   */
  dispose(options?: { releaseContext?: boolean }): void;
}

const SKY_CLEAR = 0x020308;
/** Rows of the frame (as a share of its height from the top) that {@link SpaceRenderer.probe} reads. */
const PROBE_ROWS = [0.25, 0.4, 0.55] as const;
/** A sampled pixel counts as lit when its red, green and blue add up to more than this. */
const LIT_THRESHOLD = 60;
/** A fly into a system is this far along before the other systems are taken out of the scene. */
const ALONE_AFTER = 0.85;
/** The camera's target must move this far, in scene units, before the systems in detail are chosen again. */
const DETAIL_RETARGET = 0.75;

/** What the detail choice asks of a definition: its systems, who owns each planet, and the system holding the ship. */
function indexOf(definition: SpaceDefinition): {
  readonly systems: ReadonlySet<string>;
  readonly planetOwner: ReadonlyMap<string, string>;
  readonly ship: string | undefined;
} {
  const planetOwner = new Map<string, string>();
  let ship: string | undefined;
  for (const system of definition.systems)
    for (const planet of system.planets) {
      planetOwner.set(planet.id, system.id);
      if (planet.id === definition.shipPlanetId) ship = system.id;
    }
  return { systems: new Set(definition.systems.map((system) => system.id)), planetOwner, ship };
}

const sameFocus = (a: RigFocus, b: RigFocus): boolean =>
  a.kind === b.kind && (a.kind !== 'system' || (b.kind === 'system' && a.systemId === b.systemId));

/** An in-flight move of the camera between two foci. `startedAt` is set by the first frame that draws it. */
interface Fly {
  readonly from: CameraPose;
  readonly seconds: number;
  startedAt: number | null;
}

/**
 * Creates the three.js renderer for `surface` and builds the scene on it. Throws when the surface
 * cannot give three.js a WebGL 2 context; the caller turns that into the Simple lists.
 */
export function createSpaceRenderer(
  surface: SpaceSurface,
  initial: SpaceDefinition,
  options: SpaceRendererOptions = {},
): SpaceRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: surface.canvas as HTMLCanvasElement,
    context: surface.context,
    antialias: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: surface.preserveDrawingBuffer === true,
  });
  renderer.setPixelRatio(surface.pixelRatio);
  renderer.setSize(surface.width, surface.height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(SKY_CLEAR);
  let size = { width: surface.width, height: surface.height };
  // The painted planets of this renderer; they are dropped with it, so nothing outlives the screen.
  const paintCache: PaintCache = new Map();
  let space: BuiltSpace = buildSpace(initial, size.width / size.height, surface.pixelRatio, paintCache);
  space.setViewHeight(size.height);
  let spec: SpaceCameraSpec | null = null;
  let fly: Fly | null = null;
  let script: SpaceScript | null = null;
  /** The camera a script starts from, without its breathing. */
  let scriptFrom: CameraPose | null = null;
  let highlighted: string | null = null;
  let definitionCamera: CameraPose = {
    position: initial.camera.position,
    target: initial.camera.target,
    fov: space.camera.fov,
  };
  let lastPose: CameraPose = definitionCamera;
  let far = false;

  // The systems drawn in full, for a map with more than a frame can hold (D-417).
  let current = initial;
  let known = indexOf(initial);
  const anchorScratch: AnchorScratch = {};
  let wanted: ReadonlySet<string> = new Set();
  let reported: ReadonlySet<string> | undefined;
  let chosenAt: { x: number; z: number } | undefined;
  let chosenFor = '';
  let converged = false;
  /** The systems that stay in detail whatever the distance: the one focused, glowing, scripted or holding the ship. */
  const pinnedNow = (): Set<string> => {
    const pinned = new Set<string>();
    const focus = spec?.focus;
    if (focus?.kind === 'system') pinned.add(focus.systemId);
    if (highlighted !== null) {
      const home = known.systems.has(highlighted) ? highlighted : known.planetOwner.get(highlighted);
      if (home !== undefined) pinned.add(home);
    }
    if (script !== null) pinned.add(script.systemId);
    if (known.ship !== undefined) pinned.add(known.ship);
    return pinned;
  };
  /** Chooses the systems to draw in full from where the camera looks, builds a few more of them, lets go of the rest. */
  const updateDetail = (): void => {
    if (!space.scaled) return;
    const target = { x: lastPose.target[0], z: lastPose.target[2] };
    const pinned = pinnedNow();
    const pinnedKey = [...pinned].sort().join();
    const moved = chosenAt === undefined || Math.hypot(target.x - chosenAt.x, target.z - chosenAt.z) > DETAIL_RETARGET;
    if (moved || pinnedKey !== chosenFor) {
      wanted = chooseDetail({ places: space.places, target, pinned, previous: wanted });
      chosenAt = target;
      chosenFor = pinnedKey;
      converged = false;
    }
    if (!converged) {
      space.setDetail(wanted, options.buildsPerFrame ?? DETAIL_BUILDS_PER_FRAME);
      converged = sameSet(space.detail, wanted);
    }
    if (reported === undefined || !sameSet(reported, wanted)) {
      reported = wanted;
      options.onDetail?.([...wanted]);
    }
  };
  /** A new definition: the detail is chosen again at once. */
  const redetail = (): void => {
    known = indexOf(current);
    chosenAt = undefined;
    converged = false;
    updateDetail();
  };
  if (space.scaled) updateDetail();

  /** The pose at scene time `t`: where the rig wants the camera, or part-way there during a fly. */
  const poseAt = (t: number): CameraPose => {
    const wanted = withDrift(spec === null ? definitionCamera : rigPose({ ...spec, ...size }), t);
    if (fly === null) return wanted;
    fly.startedAt ??= t;
    const elapsed = t - fly.startedAt;
    if (flyDone(elapsed, fly.seconds)) {
      fly = null;
      return wanted;
    }
    return flyPose(fly.from, wanted, elapsed, fly.seconds);
  };
  const wantedPose = (): CameraPose => (spec === null ? definitionCamera : rigPose({ ...spec, ...size }));
  const projection: Projection = {
    bodyOnScreen(position, radius) {
      space.camera.updateMatrixWorld();
      const point = position.clone();
      const edge = point
        .clone()
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(space.camera.matrixWorld, 0), radius);
      point.project(space.camera);
      edge.project(space.camera);
      const x = (point.x * 0.5 + 0.5) * size.width;
      return { x, y: (-point.y * 0.5 + 0.5) * size.height, radiusPx: Math.abs((edge.x * 0.5 + 0.5) * size.width - x) };
    },
  };
  /** A System view shows one system alone once the camera has nearly arrived. */
  const showOnlyFocus = (t: number): void => {
    const focus = spec?.focus;
    const scripted = script?.kind === 'enter-system' ? script.clock() / ENTER_SYSTEM.seconds <= ALONE_AFTER : false;
    const arrived =
      !scripted && (fly === null || (fly.startedAt !== null && (t - fly.startedAt) / fly.seconds > ALONE_AFTER));
    space.showOnly(focus?.kind === 'system' && arrived ? focus.systemId : null);
  };

  return {
    draw(t) {
      updateDetail();
      space.poseAt(t);
      let directed: DirectedFrame | undefined;
      if (script !== null && scriptFrom !== null) {
        space.scene.updateMatrixWorld(true);
        directed = directFrame({ script, space, from: scriptFrom, wanted: wantedPose(), size, t });
      }
      lastPose = directed?.pose ?? poseAt(t);
      far = spec !== null && spec.focus.kind === 'universe' && isFarPose(lastPose);
      space.setCamera(lastPose);
      showOnlyFocus(t);
      renderer.render(space.scene, space.camera);
      surface.present?.();
      directed?.report(projection);
    },
    resize(width, height) {
      size = { width, height };
      renderer.setSize(width, height, false);
      space.camera.aspect = width / height;
      space.camera.updateProjectionMatrix();
      space.setViewHeight(height);
    },
    setDefinition(next) {
      current = next;
      definitionCamera = { position: next.camera.position, target: next.camera.target, fov: space.camera.fov };
      // A map at scale changes system by system: only a system whose own definition changed is built again.
      if (space.scaled && !drawsEverything(next.systems.length)) {
        space.update(next);
        redetail();
        return;
      }
      const previous = space;
      space = buildSpace(next, size.width / size.height, surface.pixelRatio, paintCache);
      previous.dispose();
      space.setViewHeight(size.height);
      space.highlight(highlighted);
      space.setCamera(lastPose);
      // The scene was built again: a script's props are in the new one.
      if (script !== null) space.script.shipScale(1);
      reported = undefined;
      redetail();
    },
    setScript(next) {
      if (script !== null) endScript(space, script);
      script = next;
      // A glide down to a planet starts from the camera the person was looking through.
      scriptFrom = next?.kind === 'enter-planet' ? wantedPose() : null;
    },
    setCamera(next, animate) {
      const focusChanged = spec !== null && !sameFocus(spec.focus, next.focus);
      if (focusChanged && script?.kind === 'enter-system') {
        scriptFrom = wantedPose();
        fly = null;
      } else if (focusChanged && animate) {
        fly = {
          from: lastPose,
          seconds: next.focus.kind === 'system' ? FLY_SECONDS.down : FLY_SECONDS.up,
          startedAt: null,
        };
      } else if (focusChanged) fly = null;
      spec = next;
    },
    setHighlight(systemId) {
      highlighted = systemId;
      space.highlight(systemId);
    },
    anchors: () => projectAnchors(space, size, spec?.focus, anchorScratch),
    isFar: () => far,
    probe() {
      const gl = renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const row = new Uint8Array(width * 4);
      let lit = 0;
      let signature = 2166136261;
      for (const share of PROBE_ROWS) {
        gl.readPixels(0, Math.floor(height * (1 - share)), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        for (let at = 0; at < row.length; at += 4) {
          if (row[at]! + row[at + 1]! + row[at + 2]! > LIT_THRESHOLD) lit += 1;
          signature = Math.imul(signature ^ row[at]! ^ (row[at + 1]! << 8) ^ (row[at + 2]! << 16), 16777619) >>> 0;
        }
      }
      return { litPixels: lit, sampledPixels: width * PROBE_ROWS.length, signature };
    },
    dispose(options) {
      if (script !== null) endScript(space, script);
      space.dispose();
      paintCache.clear();
      renderer.dispose();
      if (options?.releaseContext === true && surface.context === undefined) renderer.forceContextLoss();
    },
  };
}
