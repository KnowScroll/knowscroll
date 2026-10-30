import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { memo, useCallback, useRef, useState } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { cappedPixelRatio } from './frame-clock';
import type { SpaceCanvasProps } from './space-canvas-props';

interface Box {
  readonly width: number;
  readonly height: number;
}

/**
 * The part of an HTMLCanvasElement that three.js touches. `expo-gl` has no canvas, so this object
 * stands in for one and hands back the native GL context.
 */
function canvasStandIn(gl: ExpoWebGLRenderingContext) {
  return {
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    clientWidth: gl.drawingBufferWidth,
    clientHeight: gl.drawingBufferHeight,
    style: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getContext: () => gl,
  };
}

/**
 * Two things in three.js do not fit a native `expo-gl` context, and the first emulator runs showed
 * both. three.js refuses any context that is `instanceof WebGLRenderingContext` ("WebGL 1 is not
 * supported"), and expo-gl's WebGL 2 context inherits from that class. It also reads
 * `getContextAttributes()` while it starts. The view returned here hides the inheritance, answers
 * the attributes a GLView is made with when the context does not, ignores colour-space hints the
 * context refuses, and passes every other call through to the real context.
 */
function asWebGL2Context(gl: ExpoWebGLRenderingContext): ExpoWebGLRenderingContext {
  const attributes = {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
    desynchronized: false,
  };
  const ownAttributes = typeof gl.getContextAttributes === 'function' ? gl.getContextAttributes() : undefined;
  // three.js reads hundreds of methods per frame: bind each once.
  const bound = new Map<string | symbol, unknown>();
  return new Proxy(gl, {
    getPrototypeOf: () => Object.prototype,
    set(target, key, value) {
      // three.js sets colour-space hints a native context may not know; they are only hints.
      try {
        return Reflect.set(target, key, value);
      } catch {
        return true;
      }
    },
    get(target, key) {
      if (key === 'getContextAttributes' && !ownAttributes) return () => attributes;
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      let method = bound.get(key);
      if (method === undefined) {
        method = (value as (...args: unknown[]) => unknown).bind(target);
        bound.set(key, method);
      }
      return method;
    },
  });
}

/**
 * The native canvas host: an `expo-gl` `GLView`. The drawing buffer of a GLView has one pixel per
 * device pixel, so to cap the pixel ratio at 1.5 the view is laid out smaller than its parent and
 * scaled up to fill it; the GPU stretches the buffer, three.js draws fewer pixels.
 */
function SpaceCanvasNative({ onSurface, onResize, onFailure }: SpaceCanvasProps) {
  const [box, setBox] = useState<Box | null>(null);
  const devicePixelRatio = PixelRatio.get();
  const pixelRatio = cappedPixelRatio(devicePixelRatio);
  const stretch = devicePixelRatio / pixelRatio;

  const lastLayout = useRef<Box | null>(null);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      const previous = lastLayout.current;
      lastLayout.current = { width, height };
      if (previous !== null && (previous.width !== width || previous.height !== height)) onResize(width, height);
      setBox({ width, height });
    },
    [onResize],
  );

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      if (gl.drawingBufferWidth <= 0 || gl.drawingBufferHeight <= 0) {
        onFailure('context-creation-failed');
        return;
      }
      onSurface({
        canvas: canvasStandIn(gl),
        context: asWebGL2Context(gl),
        width: gl.drawingBufferWidth / pixelRatio,
        height: gl.drawingBufferHeight / pixelRatio,
        pixelRatio,
        present: () => gl.endFrameEXP(),
      });
    },
    [onFailure, onSurface, pixelRatio],
  );

  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={onLayout}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {box === null ? null : (
        <GLView
          style={{
            position: 'absolute',
            width: box.width / stretch,
            height: box.height / stretch,
            left: (box.width - box.width / stretch) / 2,
            top: (box.height - box.height / stretch) / 2,
            transform: [{ scale: stretch }],
          }}
          onContextCreate={onContextCreate}
        />
      )}
    </View>
  );
}

export const SpaceCanvas = memo(SpaceCanvasNative);
