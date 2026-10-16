import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect } from '../e2e/support/origin.ts';

/** Screenshots for review; apps/web/artifacts/ is ignored by Git. */
export const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'cosmos-journey');
mkdirSync(ARTIFACTS_DIR, { recursive: true });

export const CAPTIONS = ['Your world began before you knew it.', 'Every idea can change its shape.'] as const;

/** What the page did with the opening, recorded from inside the page by `instrumentOrigin`. */
export interface OriginLog {
  events: { type: 'attach' | 'detach'; at: number; className: string }[];
  captions: { text: string; at: number }[];
  /** Whether the opening's Skip/Sound controls were ever in the document. */
  controlsShown: boolean;
  glContexts: number;
  glLost: boolean[];
  audioStates: string[];
}

/**
 * Runs before any page script in every document of the context. It records, without changing
 * behaviour: when the opening overlay attaches and detaches (and its phase class when it did),
 * every distinct caption it showed and when, the WebGL contexts the opening created on its own
 * canvas (`.origin-canvas`) and every AudioContext the page created, so a spec can ask afterwards
 * whether they were released. Times are `performance.now()` in that document.
 */
export function instrumentOrigin(): void {
  type Recorder = {
    events: { type: 'attach' | 'detach'; at: number; className: string }[];
    captions: { text: string; at: number }[];
    controls: boolean;
    gl: { isContextLost(): boolean }[];
    audio: { state: string }[];
  };
  const scope = window as unknown as { __ksOrigin?: Recorder };
  if (scope.__ksOrigin) return;
  const log: Recorder = { events: [], captions: [], controls: false, gl: [], audio: [] };
  scope.__ksOrigin = log;

  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (this: HTMLCanvasElement, ...args: unknown[]) => unknown };
  const getContext = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    const context = getContext.apply(this, args);
    if (context && this.classList.contains('origin-canvas') && String(args[0]).startsWith('webgl')) {
      log.gl.push(context as { isContextLost(): boolean });
    }
    return context;
  };

  const AudioContextClass = window.AudioContext;
  if (AudioContextClass) {
    window.AudioContext = class extends AudioContextClass {
      constructor(options?: AudioContextOptions) {
        super(options);
        log.audio.push(this);
      }
    };
  }

  let attached: Element | null = null;
  const observe = () => {
    const overlay = document.querySelector('[data-testid="origin"]');
    if (overlay && overlay !== attached) {
      if (attached) log.events.push({ type: 'detach', at: performance.now(), className: attached.className });
      attached = overlay;
      log.events.push({ type: 'attach', at: performance.now(), className: overlay.className });
    } else if (!overlay && attached) {
      log.events.push({ type: 'detach', at: performance.now(), className: attached.className });
      attached = null;
    }
    if (document.querySelector('.origin-controls')) log.controls = true;
    const text = (document.querySelector('.origin-caption')?.textContent ?? '').trim();
    if (text && log.captions.at(-1)?.text !== text) log.captions.push({ text, at: performance.now() });
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true, characterData: true });
}

export async function readOriginLog(page: Page): Promise<OriginLog> {
  return page.evaluate(() => {
    const log = (window as unknown as {
      __ksOrigin?: {
        events: OriginLog['events'];
        captions: OriginLog['captions'];
        controls: boolean;
        gl: { isContextLost(): boolean }[];
        audio: { state: string }[];
      };
    }).__ksOrigin;
    if (!log) throw new Error('instrumentOrigin did not run in this document');
    return {
      events: log.events,
      captions: log.captions,
      controlsShown: log.controls,
      glContexts: log.gl.length,
      glLost: log.gl.map(context => context.isContextLost()),
      audioStates: log.audio.map(context => context.state),
    };
  });
}

/**
 * While the opening plays exactly one WebGL context it created is live. (The dev server renders
 * under React StrictMode, which mounts effects twice: the first renderer is created and disposed
 * at once, so a development page shows one lost context before the live one.)
 */
export function expectOneLiveOpeningContext(log: OriginLog): void {
  expect(log.glContexts, 'the opening created a WebGL context').toBeGreaterThan(0);
  expect(log.glLost.filter(lost => !lost), `live opening contexts (${JSON.stringify(log.glLost)})`).toHaveLength(1);
}

/** After the opening has ended, every WebGL context it created has been given back. */
export function expectOpeningContextsReleased(log: OriginLog, openings = 1): void {
  expect(log.glContexts, 'the opening created WebGL contexts').toBeGreaterThanOrEqual(openings);
  expect(log.glLost.every(Boolean), `every opening context released (${JSON.stringify(log.glLost)})`).toBe(true);
}

export async function instrument(context: BrowserContext): Promise<void> {
  await context.addInitScript(instrumentOrigin);
}

/** Canvases in the document that are not part of the opening overlay (the Universe's own). */
export async function canvasesOutsideOrigin(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('canvas'))
      .filter(canvas => !canvas.closest('[data-testid="origin"]'))
      .map(canvas => canvas.className || '(unnamed canvas)'),
  );
}

export async function allCanvases(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map(canvas => canvas.className || '(unnamed canvas)'));
}

export async function originFlag(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('ks_origin_v1'));
}

/** No horizontal page scroll: the document is never wider than the layout viewport. */
export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.document, `${where}: page wider than the viewport (${JSON.stringify(widths)})`).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body, `${where}: body wider than the viewport (${JSON.stringify(widths)})`).toBeLessThanOrEqual(widths.viewport);
}

/** The element's whole box lies inside the viewport. */
export async function expectInsideViewport(page: Page, locator: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x, `${what} starts left of the viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${what} starts above the viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} ends right of the viewport`).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box!.y + box!.height, `${what} ends below the viewport`).toBeLessThanOrEqual(viewport.height + 0.5);
  return box!;
}

/** A touch target at least 44 × 44 CSS px (WCAG 2.5.5 / Apple HIG), measured in real layout. */
export async function expectHitArea(locator: Locator, what: string, minimum = 44): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  expect(box!.width, `${what} is ${box!.width.toFixed(1)} px wide`).toBeGreaterThanOrEqual(minimum);
  expect(box!.height, `${what} is ${box!.height.toFixed(1)} px tall`).toBeGreaterThanOrEqual(minimum);
}
