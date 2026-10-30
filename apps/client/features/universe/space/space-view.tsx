import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { space, spacing, target } from '@knowscroll/design-tokens';
import { Text, useDisplay } from '@knowscroll/ui';
import { loadSpaceRenderer } from './load-space-renderer';
import { createRenderLoop, type RenderLoop } from './render-loop';
import { SpaceCanvas } from './space-canvas';
import type { SpaceDefinition } from './space-definition';
import type { SpaceRenderer } from './space-renderer';
import type { SpaceAnchor, SpaceChoice, SpaceFailure, SpaceProbe, SpaceSurface } from './space-surface';
import { useAppActive } from './use-app-active';

/** One drawn frame, for the developer gallery and the gate tests. */
export interface SpaceFrameSample {
  /** The scene time of the frame, seconds. */
  readonly t: number;
  /** The frame's `requestAnimationFrame` stamp, milliseconds. 0 for the reduced-motion still. */
  readonly atMs: number;
  /** CPU time `draw` took (GPU work is not included), milliseconds. */
  readonly drawMs: number;
  /** A reading of the pixels, taken on every {@link PROBE_EVERY}th frame and on the first. */
  readonly probe?: SpaceProbe;
}

export interface SpaceViewProps {
  readonly definition: SpaceDefinition;
  /** Shown instead of the drawing when 3D is not available: the Simple lists. */
  readonly fallback: (reason: SpaceFailure) => ReactNode;
  /** A label or planet was chosen. */
  readonly onChoose?: (choice: SpaceChoice) => void;
  /** Developer gallery only. Makes the drawing readable and reports every frame. */
  readonly diagnostics?: {
    readonly onFrame: (sample: SpaceFrameSample) => void;
    readonly onFailure?: (reason: SpaceFailure) => void;
  };
}

/** The pixel probe costs a read-back, so it samples now and then, not every frame. */
const PROBE_EVERY = 15;

const browserScheduler = {
  request: (callback: (nowMs: number) => void) => requestAnimationFrame(callback),
  cancel: (handle: number) => cancelAnimationFrame(handle),
};

/**
 * A 3D space view: the sun, haze, planets and dust of the Universe drawn by three.js on the
 * platform canvas, with accessible labels laid over it. It owns the frame loop and decides when
 * the loop may run: not when the route is unfocused, the app is not active, the canvas is off
 * screen or WebGL has failed. When 3D is not available it shows `fallback` instead, never a blank.
 *
 * Reduced motion draws one frame and never starts a loop.
 */
export function SpaceView({ definition, fallback, onChoose, diagnostics }: SpaceViewProps) {
  const { reducedMotion } = useDisplay();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [onScreen, setOnScreen] = useState(true);
  const [failure, setFailure] = useState<SpaceFailure | null>(null);
  const [ready, setReady] = useState(false);
  const [anchors, setAnchors] = useState<readonly SpaceAnchor[]>([]);
  const loop = useRef<RenderLoop | null>(null);
  const renderer = useRef<SpaceRenderer | null>(null);
  const disposed = useRef(false);
  const frames = useRef(0);

  const live = useRef({ diagnostics, reducedMotion, definition });
  useEffect(() => {
    live.current = { diagnostics, reducedMotion, definition };
  });

  const fail = useCallback((reason: SpaceFailure) => {
    loop.current?.dispose();
    loop.current = null;
    renderer.current?.dispose();
    renderer.current = null;
    setFailure(reason);
    live.current.diagnostics?.onFailure?.(reason);
  }, []);

  const startDrawing = useCallback(
    async (surface: SpaceSurface) => {
      try {
        const { createSpaceRenderer } = await loadSpaceRenderer();
        if (disposed.current) return;
        const created = createSpaceRenderer(
          { ...surface, preserveDrawingBuffer: live.current.diagnostics !== undefined },
          live.current.definition,
        );
        renderer.current = created;
        loop.current = createRenderLoop({
          reducedMotion: live.current.reducedMotion,
          scheduler: browserScheduler,
          draw: (t, atMs) => {
            const started = performance.now();
            try {
              created.draw(t);
            } catch {
              fail('render-failed');
              return;
            }
            const drawMs = performance.now() - started;
            frames.current += 1;
            const probe = frames.current % PROBE_EVERY === 1 ? created.probe() : undefined;
            setAnchors(created.anchors());
            live.current.diagnostics?.onFrame({ t, atMs, drawMs, probe });
          },
        });
        setReady(true);
      } catch {
        fail('context-creation-failed');
      }
    },
    [fail],
  );

  const active = ready && failure === null && focused && appActive && onScreen;
  useEffect(() => {
    loop.current?.setActive(active);
  }, [active]);

  useEffect(
    () => () => {
      disposed.current = true;
      loop.current?.dispose();
      renderer.current?.dispose();
    },
    [],
  );

  const resize = useCallback((width: number, height: number) => {
    renderer.current?.resize(width, height);
    loop.current?.redraw();
  }, []);

  if (failure !== null) return <>{fallback(failure)}</>;
  return (
    <View style={styles.fill}>
      <SpaceCanvas
        onSurface={(surface) => void startDrawing(surface)}
        onResize={resize}
        onFailure={fail}
        onOnScreen={setOnScreen}
        preserveDrawingBuffer={diagnostics !== undefined}
      />
      {anchors.map((anchor) =>
        anchor.visible ? <AnchorLabel key={anchor.id} anchor={anchor} onChoose={onChoose} /> : null,
      )}
    </View>
  );
}

/** A label and tap target over a point of the scene: an ordinary view at the projected position. */
function AnchorLabel({
  anchor,
  onChoose,
}: {
  readonly anchor: SpaceAnchor;
  readonly onChoose?: (choice: SpaceChoice) => void;
}) {
  const label = anchor.kind === 'system' ? `${anchor.name}, a system` : `${anchor.name}, a planet`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onChoose?.(anchor)}
      style={[
        styles.label,
        { left: anchor.x - LABEL_WIDTH / 2, top: anchor.y + (anchor.kind === 'system' ? spacing[8] : spacing[2]) },
      ]}
    >
      <Text variant="uiS" color={space.label} align="center">
        {anchor.name}
      </Text>
    </Pressable>
  );
}

/** Wide enough for a place name; the text is centred under its point. */
const LABEL_WIDTH = 144;

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#020308' },
  label: {
    position: 'absolute',
    width: LABEL_WIDTH,
    minHeight: target.minimum,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
});
