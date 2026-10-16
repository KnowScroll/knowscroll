import { useEffect, useRef, type RefObject } from 'react';
import { SkyRenderer, type SkyBody, type SkyGas } from './gl/SkyRenderer.ts';
import type { StarCondition } from './starView.ts';

/**
 * Paints the sky behind the DOM that lays it out. Every interactive object is a real button with
 * `data-sky` attributes; this component reads where those buttons are each frame and draws the
 * matching star, world or gas with the opening's shaders. If WebGL is unavailable it reports
 * `css` and the buttons keep their own CSS drawing. Reduced motion freezes the sky's time.
 *
 * Attributes it reads:
 *   data-sky="star"     data-condition, data-radius, data-seed, data-worlds, data-motes
 *   data-sky="world"    data-world="facet|question", data-radius, data-seed
 *   data-sky="seed"     data-radius (the unformed cloud of a new universe)
 *   data-sky="frontier" data-radius (what has not been met yet)
 */
export interface SkySurfaceProps {
  anchors: RefObject<HTMLElement | null>;
  reducedMotion: boolean;
  onMode?: (mode: 'gl' | 'css') => void;
  className?: string;
}

const STAR_STYLE: Record<StarCondition, { color: [number, number, number]; intensity: number; granulation: number; tension: number; mode: 0 | 2 }> = {
  quiet: { color: [1.0, 0.8, 0.52], intensity: 0.82, granulation: 0.3, tension: 0, mode: 0 },
  stirring: { color: [1.0, 0.84, 0.56], intensity: 1.0, granulation: 0.8, tension: 0, mode: 0 },
  tense: { color: [1.0, 0.6, 0.38], intensity: 1.0, granulation: 0.85, tension: 0.8, mode: 0 },
  luminous: { color: [0.86, 0.92, 1.0], intensity: 1.2, granulation: 0.6, tension: 0, mode: 2 },
};
const FACET_COLORS: [number, number, number][] = [[0.2, 0.85, 0.72], [0.28, 0.42, 0.98]];
const EVENT_SECONDS = 4.2;
const QUESTION_COLORS: [number, number, number][] = [[0.93, 0.53, 0.7], [1.0, 0.84, 0.55]];

function num(el: HTMLElement, name: string, fallback: number): number {
  const value = Number(el.dataset[name]);
  return Number.isFinite(value) ? value : fallback;
}

interface Anchor {
  kind: string;
  x: number;
  y: number;
  radius: number;
  seed: number;
  condition: StarCondition;
  emphasis: boolean;
  worlds: number;
  motes: number;
  world: string | undefined;
  event: string | undefined;
  eventAt: number;
}

/** Turns the measured anchors into what the renderer draws at `time` (a recorded change plays once). */
function paint(anchors: Anchor[], time: number, now: number): { bodies: SkyBody[]; gas: SkyGas[] } {
  const bodies: SkyBody[] = [];
  const gas: SkyGas[] = [];
  for (const a of anchors) {
    const { x, y, radius, seed } = a;
    switch (a.kind) {
      case 'star': {
        const style = STAR_STYLE[a.condition] ?? STAR_STYLE.quiet;
        const emphasis = a.emphasis ? 1.15 : 1;
        const kind = a.event;
        const elapsed = kind ? (now - a.eventAt) / 1000 : 99;
        const live = kind !== undefined && elapsed >= 0 && elapsed < EVENT_SECONDS;
        const p = live ? elapsed / EVENT_SECONDS : 1;
        const swell = live ? Math.sin(Math.PI * p) : 0;
        const ignite = kind === 'star_ignited' && live ? Math.min(1, elapsed / 1.4) : 1;
        bodies.push({ x, y, radius: radius * (0.15 + 0.85 * ignite) * (1 + 0.18 * swell), color: style.color, intensity: style.intensity * emphasis * (1 + 1.3 * swell), granulation: style.granulation, tension: style.tension, mode: style.mode, seed });
        if (live && kind === 'luminous') {
          gas.push({ x, y, radius: radius * 5, color: [0.6, 0.62, 0.72], density: 0.9 * swell, kind: 'shell', a: 0.25 + 0.5 * p, b: 0.2 });
        }
        if (live && (kind === 'world_formed' || kind === 'question_world')) {
          const grow = Math.min(1, elapsed / (EVENT_SECONDS * 0.7));
          const angle = seed * 6.28 + 0.8;
          const orbit = radius * (4.2 - 1.6 * grow);
          bodies.push({ x: x + Math.cos(angle) * orbit, y: y + Math.sin(angle) * orbit * 0.42, radius: Math.max(2.4, radius * 0.32 * grow), color: kind === 'question_world' ? QUESTION_COLORS[0]! : FACET_COLORS[0]!, intensity: 1, granulation: 0, tension: 0, mode: 1, seed: seed + 0.5 });
          gas.push({ x: x + Math.cos(angle) * orbit, y: y + Math.sin(angle) * orbit * 0.42, radius: radius * 2.2 * (1 - grow * 0.6), color: [0.35, 0.55, 0.62], density: 0.6 * (1 - grow), kind: 'cloud', a: 0.1, b: 0 });
        }
        for (let i = 0; i < Math.min(a.worlds, 4); i++) {
          const orbit = radius * (2.3 + i * 0.55);
          const angle = seed * 6.28 + i * 2.1 + time * (0.22 / (1 + i * 0.6));
          bodies.push({ x: x + Math.cos(angle) * orbit, y: y + Math.sin(angle) * orbit * 0.42, radius: Math.max(2.4, radius * 0.2), color: FACET_COLORS[i % 2]!, intensity: 1, granulation: 0, tension: 0, mode: 1, seed: seed + i * 0.1 });
        }
        for (let i = 0; i < Math.min(a.motes, 6); i++) {
          const angle = seed * 3 + i * (6.28 / Math.max(a.motes, 1)) + time * 0.05;
          const r = radius * (3.5 + (i % 2) * 0.6);
          bodies.push({ x: x + Math.cos(angle) * r, y: y + Math.sin(angle) * r * 0.8, radius: 1.3, color: [0.55, 0.95, 0.9], intensity: 0.55 + 0.25 * Math.sin(time * 0.8 + i), granulation: 0, tension: 0, mode: 0, seed: i * 0.07 });
        }
        if (a.condition === 'tense') {
          gas.push({ x, y, radius: radius * 4.5, color: [0.55, 0.24, 0.2], density: 0.35, kind: 'cloud', a: 0.1, b: 0 });
        }
        break;
      }
      case 'world': {
        const palette = a.world === 'question' ? QUESTION_COLORS : FACET_COLORS;
        bodies.push({ x, y, radius, color: palette[Math.floor(seed * 10) % 2]!, intensity: 1, granulation: 0, tension: 0, mode: 1, seed });
        break;
      }
      case 'seed':
        gas.push({ x, y, radius, color: [0.3, 0.55, 0.62], density: 0.8, kind: 'seed', a: 0.15, b: 0 });
        break;
      case 'frontier':
        gas.push({ x, y, radius, color: [0.2, 0.36, 0.55], density: 0.42, kind: 'cloud', a: -0.05, b: 0 });
        break;
      default:
        break;
    }
  }
  return { bodies, gas };
}

export function SkySurface({ anchors, reducedMotion, onMode, className }: SkySurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onModeRef = useRef(onMode);
  onModeRef.current = onMode;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const stage: HTMLDivElement = host;
    const canvas = document.createElement('canvas');
    canvas.className = 'sky-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    let renderer: SkyRenderer;
    try {
      renderer = new SkyRenderer(canvas);
    } catch {
      canvas.remove();
      onModeRef.current?.('css');
      return undefined;
    }
    onModeRef.current?.('gl');
    // Layout size, not the on-screen box: a parent's transform (the star approach) scales the
    // canvas and its anchors together, so the canvas keeps its own unscaled size.
    let width = 0;
    let height = 0;
    let dirty = true;
    // CSS transitions (the camera easing) move anchors for a while after one style change.
    let settleUntil = 0;
    let anchorsCache: Anchor[] = [];
    const size = () => {
      width = host.offsetWidth;
      height = host.offsetHeight;
      renderer.resize(width, height, window.devicePixelRatio || 1);
      dirty = true;
      schedule();
    };
    // Positions are read from the DOM only when layout can have changed: a resize, the camera
    // moving (a style change on the anchors' root) or a body appearing, changing or leaving.
    const measure = () => {
      const root = anchors.current;
      if (!root) return;
      const origin = host.getBoundingClientRect();
      const sx = origin.width > 0 ? width / origin.width : 1;
      const sy = origin.height > 0 ? height / origin.height : 1;
      anchorsCache = [];
      root.querySelectorAll<HTMLElement>('[data-sky]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        anchorsCache.push({
          kind: el.dataset.sky ?? '',
          x: (rect.left + rect.width / 2 - origin.left) * sx,
          y: (rect.top + rect.height / 2 - origin.top) * sy,
          radius: num(el, 'radius', 16) * num(el, 'scale', 1),
          seed: num(el, 'seed', 0.5),
          condition: (el.dataset.condition as StarCondition | undefined) ?? 'quiet',
          emphasis: el.dataset.emphasis === '1',
          worlds: num(el, 'worlds', 0),
          motes: num(el, 'motes', 0),
          world: el.dataset.world,
          event: el.dataset.event,
          eventAt: num(el, 'eventAt', 0),
        });
      });
      dirty = false;
    };
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
    resizeObserver?.observe(host);
    const mutations = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { dirty = true; settleUntil = performance.now() + 700; schedule(); })
      : null;
    if (anchors.current) mutations?.observe(anchors.current, { attributes: true, childList: true, subtree: true });

    let raf = 0;
    let last = 0;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    const start = performance.now();
    function schedule() {
      if (!raf && !waiting) raf = requestAnimationFrame(frame);
    }
    function frame(now: number) {
      raf = 0;
      if (renderer.contextLost) {
        canvas.remove();
        onModeRef.current?.('css');
        return;
      }
      // Under the opening the Universe is sealed and unseen: draw nothing, look again shortly.
      if (stage.closest('[inert]')) {
        waiting = setTimeout(() => { waiting = null; dirty = true; schedule(); }, 300);
        return;
      }
      const settling = now < settleUntil;
      if (settling) dirty = true;
      const animating = !reducedMotion || settling;
      if (animating && now - last < 32) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (!dirty && !animating) return;
      last = now;
      if (stage.offsetWidth !== width || stage.offsetHeight !== height) {
        width = stage.offsetWidth;
        height = stage.offsetHeight;
        renderer.resize(width, height, window.devicePixelRatio || 1);
        dirty = true;
      }
      if (dirty) measure();
      const time = reducedMotion ? 0 : (now - start) / 1000;
      const { bodies, gas } = paint(anchorsCache, time, now);
      renderer.render(bodies, gas, time);
      if (animating) raf = requestAnimationFrame(frame);
    }
    size();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (waiting) clearTimeout(waiting);
      resizeObserver?.disconnect();
      mutations?.disconnect();
      renderer.dispose();
      canvas.remove();
    };
  }, [anchors, reducedMotion]);

  return <div ref={hostRef} className={`sky-surface${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
