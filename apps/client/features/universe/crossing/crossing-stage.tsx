import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SpaceCanvas } from '../space/space-canvas';
import type { SpaceFailure, SpaceSurface } from '../space/space-surface';
import type { CrossingFrame } from './crossing-frame';
import { CrossingMarks } from './crossing-marks';
import type { CrossingRenderer } from './crossing-renderer';
import { loadCrossingRenderer } from './load-crossing-renderer';

const GROUND = '#000000';

/** What went wrong, in one short line, for the developer gallery. */
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * The crossing's picture for one frame: the shader on a canvas, the 2D marks over it, everything shaken together. The
 * owner decides which frame (a still at any `q`, or the film playing); this draws it. The renderer, three.js and the
 * shader come in on the first draw. If WebGL cannot be had the marks still show, over black, and `onFailure` says why.
 */
export function CrossingStage({
  frame,
  size,
  behindSeed,
  aheadSeed,
  onDrawn,
  onFailure,
  preserveDrawingBuffer,
}: {
  readonly frame: CrossingFrame;
  /** The size `frame` was made for, in layout px. */
  readonly size: { readonly width: number; readonly height: number };
  readonly behindSeed: string;
  readonly aheadSeed: string;
  /** The shader's part of `frame` is on the canvas. */
  readonly onDrawn?: (frame: CrossingFrame) => void;
  readonly onFailure?: (reason: SpaceFailure, detail?: string) => void;
  /** Developer gallery only: keeps the drawing readable for screenshots and pixel reads. */
  readonly preserveDrawingBuffer?: boolean;
}) {
  const [renderer, setRenderer] = useState<CrossingRenderer | null>(null);
  const live = useRef({ frame, onDrawn, onFailure });
  const owned = useRef<CrossingRenderer | null>(null);
  /** Bumped for every new surface and on unmount, so a renderer that arrives late is never used. */
  const generation = useRef(0);
  useEffect(() => {
    live.current = { frame, onDrawn, onFailure };
  });

  // The marks stay over black when the shader cannot be drawn; the owner is told why.
  const fail = useCallback((reason: SpaceFailure, detail?: string) => {
    live.current.onFailure?.(reason, detail);
  }, []);

  const onSurface = useCallback(
    (surface: SpaceSurface) => {
      owned.current?.dispose();
      owned.current = null;
      generation.current += 1;
      const mine = generation.current;
      loadCrossingRenderer()
        .then(({ createCrossingRenderer }) => {
          if (generation.current !== mine) return;
          const created = createCrossingRenderer(surface);
          owned.current = created;
          setRenderer(created);
        })
        .catch((error: unknown) => {
          if (generation.current === mine) fail('context-creation-failed', describe(error));
        });
    },
    [fail],
  );

  // A resize clears the buffer, so the frame is drawn again.
  const onResize = useCallback((width: number, height: number) => {
    owned.current?.resize(width, height);
    owned.current?.draw(live.current.frame);
  }, []);

  useEffect(() => {
    if (renderer === null) return;
    try {
      renderer.draw(frame);
    } catch (error) {
      fail('render-failed', describe(error));
      return;
    }
    live.current.onDrawn?.(frame);
  }, [renderer, frame, fail]);

  useEffect(
    () => () => {
      generation.current += 1;
      owned.current?.dispose({ releaseContext: true });
      owned.current = null;
      setRenderer(null);
    },
    [],
  );

  return (
    <View testID="ks-crossing-stage" style={styles.stage}>
      <View style={[styles.shaken, { transform: [{ translateX: frame.shake.x }, { translateY: frame.shake.y }] }]}>
        <SpaceCanvas
          onSurface={onSurface}
          onResize={onResize}
          onFailure={fail}
          onOnScreen={noop}
          {...(preserveDrawingBuffer === undefined ? {} : { preserveDrawingBuffer })}
        />
        <CrossingMarks frame={frame} size={size} behindSeed={behindSeed} aheadSeed={aheadSeed} />
      </View>
    </View>
  );
}

const noop = (): void => {};

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: 'hidden', backgroundColor: GROUND },
  shaken: { flex: 1 },
});
