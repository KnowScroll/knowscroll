import { memo, useEffect, useRef } from 'react';
import { cappedPixelRatio } from './frame-clock';
import type { SpaceCanvasProps } from './space-canvas-props';

/**
 * The web canvas host: a DOM `<canvas>` that fills its parent. three.js makes the WebGL 2 context
 * from it. The host reports its size, WebGL loss and whether it is on screen; it draws nothing.
 *
 * The canvas is decorative (`aria-hidden`): places are reached through the labels over it and the
 * Simple lists, never through the picture.
 */
function SpaceCanvasWeb({ onSurface, onResize, onFailure, onOnScreen, preserveDrawingBuffer }: SpaceCanvasProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // The callbacks change identity with the owner's renders; the effect must run once per mount.
  const latest = useRef({ onSurface, onResize, onFailure, onOnScreen });
  useEffect(() => {
    latest.current = { onSurface, onResize, onFailure, onOnScreen };
  });

  useEffect(() => {
    const holderNode = holder.current;
    const canvasNode = canvas.current;
    if (holderNode === null || canvasNode === null) return;
    if (typeof WebGL2RenderingContext === 'undefined') {
      latest.current.onFailure('webgl-unavailable');
      return;
    }
    let surfaceMade = false;
    const reportSize = (width: number, height: number): void => {
      if (width <= 0 || height <= 0) return;
      if (surfaceMade) {
        latest.current.onResize(width, height);
        return;
      }
      surfaceMade = true;
      latest.current.onSurface({
        canvas: canvasNode,
        width,
        height,
        pixelRatio: cappedPixelRatio(window.devicePixelRatio),
        preserveDrawingBuffer,
      });
    };
    const sizeObserver = new ResizeObserver(([entry]) => {
      if (entry !== undefined) reportSize(entry.contentRect.width, entry.contentRect.height);
    });
    sizeObserver.observe(holderNode);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      if (entry !== undefined) latest.current.onOnScreen(entry.isIntersecting);
    });
    visibilityObserver.observe(holderNode);
    const onLost = (event: Event): void => {
      // Without preventDefault the browser would not offer a restored context at all.
      event.preventDefault();
      latest.current.onFailure('context-lost');
    };
    canvasNode.addEventListener('webglcontextlost', onLost);
    return () => {
      sizeObserver.disconnect();
      visibilityObserver.disconnect();
      canvasNode.removeEventListener('webglcontextlost', onLost);
    };
  }, [preserveDrawingBuffer]);

  return (
    <div ref={holder} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <canvas ref={canvas} aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}

export const SpaceCanvas = memo(SpaceCanvasWeb);
