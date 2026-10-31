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
import { buildSpace, type BuiltSpace } from './scene/build-scene';
import type { PaintCache } from './scene/context';
import { directFrame, endScript, type DirectedFrame, type Projection } from './script-director';
import type { SpaceDefinition } from './space-definition';
import type { SpaceScript } from './space-script';
import type { SpaceAnchor, SpaceProbe, SpaceSurface } from './space-surface';

/** What the person's camera looks at and how far they have panned and zoomed. The renderer adds the size. */
export type SpaceCameraSpec = Omit<RigSpec, 'width' | 'height'>;

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
export function createSpaceRenderer(surface: SpaceSurface, initial: SpaceDefinition): SpaceRenderer {
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
    },
    setDefinition(next) {
      const previous = space;
      space = buildSpace(next, size.width / size.height, surface.pixelRatio, paintCache);
      previous.dispose();
      definitionCamera = { position: next.camera.position, target: next.camera.target, fov: space.camera.fov };
      space.highlight(highlighted);
      space.setCamera(lastPose);
      // The scene was built again: a script's props are in the new one.
      if (script !== null) space.script.shipScale(1);
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
    anchors() {
      space.camera.updateMatrixWorld();
      const point = new THREE.Vector3();
      const edge = new THREE.Vector3();
      const right = new THREE.Vector3().setFromMatrixColumn(space.camera.matrixWorld, 0);
      return space.anchors.map(({ id, kind, name, caption, systemId, object, radius }) => {
        object.getWorldPosition(point);
        edge.copy(point).addScaledVector(right, radius);
        point.project(space.camera);
        edge.project(space.camera);
        const x = (point.x * 0.5 + 0.5) * size.width;
        const y = (-point.y * 0.5 + 0.5) * size.height;
        return {
          id,
          kind,
          name,
          ...(caption === undefined ? {} : { caption }),
          systemId,
          x,
          y,
          radiusPx: Math.abs((edge.x * 0.5 + 0.5) * size.width - x),
          visible: point.z < 1 && object.visible,
        };
      });
    },
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
