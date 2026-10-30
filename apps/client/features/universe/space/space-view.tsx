import { useIsFocused } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { space, spacing, target } from '@knowscroll/design-tokens';
import { Text, useDisplay } from '@knowscroll/ui';
import { loadSpaceRenderer } from './load-space-renderer';
import { createRenderLoop, type RenderLoop } from './render-loop';
import { reuseUnchangedAnchors } from './reuse-anchors';
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
    readonly onFailure?: (reason: SpaceFailure, detail?: string) => void;
  };
}

/** What went wrong, in one short line, for the developer gallery (never shown to a person). */
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

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
 * screen, WebGL has failed or the device is short of memory. When 3D is not available it shows
 * `fallback` instead, never a blank.
 *
 * Reduced motion draws one frame and never starts a loop.
 */
export function SpaceView({ definition, fallback, onChoose, diagnostics }: SpaceViewProps) {
  const { reducedMotion } = useDisplay();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [onScreen, setOnScreen] = useState(true);
  const [failure, setFailure] = useState<SpaceFailure | null>(null);
  const [anchors, setAnchors] = useState<readonly SpaceAnchor[]>([]);
  const loop = useRef<RenderLoop | null>(null);
  const renderer = useRef<SpaceRenderer | null>(null);
  /** Bumped for every new surface and on unmount, so a start that was overtaken never draws. */
  const generation = useRef(0);
  const frames = useRef(0);

  const active = failure === null && focused && appActive && onScreen;
  const live = useRef({ diagnostics, reducedMotion, definition, active, failed: false });
  useEffect(() => {
    live.current = { ...live.current, diagnostics, reducedMotion, definition, active };
  });

  /** Stops the loop and releases the renderer, if there are any. */
  const teardown = useCallback((releaseContext = false) => {
    loop.current?.dispose();
    loop.current = null;
    renderer.current?.dispose({ releaseContext });
    renderer.current = null;
  }, []);

  const fail = useCallback(
    (reason: SpaceFailure, detail?: string) => {
      if (live.current.failed) return;
      live.current.failed = true;
      generation.current += 1;
      teardown();
      setFailure(reason);
      live.current.diagnostics?.onFailure?.(reason, detail);
    },
    [teardown],
  );

  /**
   * A canvas surface is ready. It can come again for the same view: on Android `expo-gl` makes a
   * new GL context after the app returns from the background. The old renderer belongs to the dead
   * context, so it is released and the new one starts from scratch.
   */
  const startDrawing = useCallback(
    async (surface: SpaceSurface) => {
      teardown();
      generation.current += 1;
      const mine = generation.current;
      try {
        const { createSpaceRenderer } = await loadSpaceRenderer();
        if (generation.current !== mine) return;
        const created = createSpaceRenderer(
          { ...surface, preserveDrawingBuffer: live.current.diagnostics !== undefined },
          live.current.definition,
        );
        renderer.current = created;
        const drawing = createRenderLoop({
          reducedMotion: live.current.reducedMotion,
          scheduler: browserScheduler,
          draw: (t, atMs) => {
            const started = performance.now();
            try {
              created.draw(t);
            } catch (error) {
              fail('render-failed', describe(error));
              return;
            }
            const drawMs = performance.now() - started;
            frames.current += 1;
            const probe = frames.current % PROBE_EVERY === 1 ? created.probe() : undefined;
            setAnchors((previous) => reuseUnchangedAnchors(previous, created.anchors()));
            live.current.diagnostics?.onFrame({ t, atMs, drawMs, probe });
          },
        });
        loop.current = drawing;
        drawing.setActive(live.current.active);
      } catch (error) {
        if (generation.current === mine) fail('context-creation-failed', describe(error));
      }
    },
    [fail, teardown],
  );

  useEffect(() => {
    loop.current?.setActive(active);
  }, [active]);

  // The device is short of memory: the lists are lighter than a GL scene.
  useEffect(() => {
    const subscription = AppState.addEventListener('memoryWarning', () => fail('low-memory'));
    return () => subscription.remove();
  }, [fail]);

  // Mount and unmount. A strict-mode mount runs this twice; the second run starts clean.
  useEffect(() => {
    live.current.failed = false;
    return () => {
      generation.current += 1;
      teardown(true);
    };
  }, [teardown]);

  const resize = useCallback((width: number, height: number) => {
    renderer.current?.resize(width, height);
    loop.current?.redraw();
  }, []);
  const onSurface = useCallback((surface: SpaceSurface) => void startDrawing(surface), [startDrawing]);

  if (failure !== null) return <>{fallback(failure)}</>;
  return (
    <View style={styles.fill}>
      <SpaceCanvas
        onSurface={onSurface}
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
const AnchorLabel = memo(function AnchorLabel({
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
});

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
