import { useCallback, useEffect, useRef, useState } from 'react';
import { chooseQuality, OriginRenderer, type SeedTarget } from './gl/OriginRenderer.ts';
import { OriginSound } from './originSound.ts';
import { captionAt, HANDOFF_START, ORIGIN_DURATION, STILLS } from './timeline.ts';
import './origin.css';

export type OriginEnd = 'complete' | 'skipped' | 'returning' | 'failed';

export interface OriginExperienceProps {
  reducedMotion: boolean;
  /** Where the Universe's first possibility sits on screen, so the last frame lands on it. */
  findSeedTarget: () => SeedTarget | null;
  /** Set by the app when the opening should give way quietly (a returning reader, an error). */
  dismiss?: 'returning' | 'unavailable' | null;
  /** While the app cannot yet tell a first visit from a returning reader: a dark frame only, no
   * story and no controls, so a returning reader goes to their Universe without seeing it. */
  hold?: boolean;
  /** The live Universe may take input from here on (the overlay is dissolving into it). */
  onHandoff: () => void;
  onEnd: (reason: OriginEnd) => void;
}

type Phase = 'playing' | 'stills' | 'fallback' | 'leaving';

const STILL_HOLD_MS = 3400;

/** Captions sit inside the lower cinema bar while there is one, like film subtitles. */
function frameCaption(root: HTMLElement | null, caption: HTMLElement | null, barFraction: number, opacity: number): void {
  if (caption) caption.style.setProperty('--o', String(opacity));
  if (!root) return;
  const bar = barFraction * window.innerHeight;
  if (bar > 56) {
    root.style.setProperty('--bar', `${bar}px`);
    root.classList.add('origin--bars');
  } else {
    root.style.removeProperty('--bar');
    root.classList.remove('origin--bars');
  }
}
const FALLBACK_MS = 7600;

/**
 * The cosmic-origin opening (ADR-0051 §5). A WebGL scene drawn from the deterministic timeline,
 * with all text and controls in the live interface: captions, Skip, optional sound and, under
 * reduced motion, a sequence of still frames the reader advances or lets advance. If WebGL is
 * unavailable or the context is lost, a short CSS version plays instead; nothing ever blocks the
 * way into the Universe. On exit every frame loop, GPU object and audio node is released.
 */
export function OriginExperience({ reducedMotion, findSeedTarget, dismiss = null, hold = false, onHandoff, onEnd }: OriginExperienceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const captionRef = useRef<HTMLParagraphElement | null>(null);
  const rendererRef = useRef<OriginRenderer | null>(null);
  const soundRef = useRef<OriginSound | null>(null);
  const clockRef = useRef<{ start: number; pausedAt: number | null; t: number }>({ start: 0, pausedAt: null, t: 0 });
  const endedRef = useRef(false);
  const handedOffRef = useRef(false);
  const [phase, setPhase] = useState<Phase>(reducedMotion ? 'stills' : 'playing');
  const [caption, setCaption] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [stillIndex, setStillIndex] = useState(0);
  // An invitation to sound for the first seconds of the story; tapping the scene accepts it.
  const [soundHint, setSoundHint] = useState(true);

  const finish = useCallback((reason: OriginEnd) => {
    if (endedRef.current) return;
    endedRef.current = true;
    soundRef.current?.stop();
    soundRef.current = null;
    if (!handedOffRef.current) {
      handedOffRef.current = true;
      onHandoff();
    }
    onEnd(reason);
  }, [onEnd, onHandoff]);

  const handOff = useCallback(() => {
    if (handedOffRef.current) return;
    handedOffRef.current = true;
    // From here the Universe takes input; the dissolving scene no longer catches clicks.
    rootRef.current?.classList.add('origin--handed');
    onHandoff();
  }, [onHandoff]);

  // Create the renderer once, on a fresh canvas for this mount, and release everything on unmount.
  // A later switch to the CSS version (a lost context) leaves the renderer to be released here.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const canvas = document.createElement('canvas');
    canvas.className = 'origin-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    let renderer: OriginRenderer;
    try {
      renderer = new OriginRenderer(canvas, chooseQuality(window.innerWidth, window.innerHeight));
    } catch {
      canvas.remove();
      setPhase(current => (current === 'leaving' ? current : 'fallback'));
      return undefined;
    }
    rendererRef.current = renderer;
    const resize = () => {
      renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      renderer.seedTarget = findSeedTarget();
    };
    resize();
    window.addEventListener('resize', resize);
    const lost = (event: Event) => {
      event.preventDefault();
      canvas.style.visibility = 'hidden';
      setPhase(current => (current === 'leaving' ? current : 'fallback'));
    };
    canvas.addEventListener('webglcontextlost', lost);
    return () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      canvas.remove();
      rendererRef.current = null;
    };
    // Built once per mount; findSeedTarget is a stable module function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live playback: one frame loop, paused while the tab is hidden so nothing is missed.
  useEffect(() => {
    if (phase !== 'playing' || hold) return undefined;
    const renderer = rendererRef.current;
    if (!renderer) return undefined;
    let raf = 0;
    const clock = clockRef.current;
    clock.start = performance.now() - clock.t * 1000;
    // A tab hidden when the story starts is paused from the start, so nothing plays unseen.
    clock.pausedAt = document.hidden ? performance.now() : null;
    let lastCaption: string | null = null;
    let targetCheck = 0;
    const loop = (now: number) => {
      if (clock.pausedAt !== null) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const t = (now - clock.start) / 1000;
      clock.t = t;
      if (t >= ORIGIN_DURATION) {
        finish('complete');
        return;
      }
      if (renderer.contextLost) {
        setPhase(current => (current === 'leaving' ? current : 'fallback'));
        return;
      }
      if (t > HANDOFF_START - 1.2 && now - targetCheck > 400) {
        targetCheck = now;
        renderer.seedTarget = findSeedTarget();
      }
      const frame = renderer.render(t, t);
      if (rootRef.current) rootRef.current.style.opacity = String(frame.overlay);
      if (t >= HANDOFF_START) handOff();
      const { text, opacity } = captionAt(t);
      if (text !== lastCaption) {
        lastCaption = text;
        setCaption(text);
      }
      frameCaption(rootRef.current, captionRef.current, renderer.letterboxNow, opacity);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const visibility = () => {
      if (document.hidden) clock.pausedAt = performance.now();
      else if (clock.pausedAt !== null) {
        clock.start += performance.now() - clock.pausedAt;
        clock.pausedAt = null;
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [phase, hold, finish, findSeedTarget, handOff]);

  // Reduced motion: still frames, no frame loop. Each still is drawn once.
  useEffect(() => {
    if (phase !== 'stills' || hold) return undefined;
    const still = STILLS[stillIndex];
    if (!still) {
      handOff();
      if (rootRef.current) rootRef.current.classList.add('origin--dissolve');
      const timer = setTimeout(() => finish('complete'), 450);
      return () => clearTimeout(timer);
    }
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.seedTarget = findSeedTarget();
      renderer.render(still.t, still.t);
    }
    setCaption(still.caption);
    frameCaption(rootRef.current, captionRef.current, renderer?.letterboxNow ?? 0, still.caption ? 1 : 0);
    const timer = setTimeout(() => setStillIndex(index => index + 1), STILL_HOLD_MS);
    return () => clearTimeout(timer);
  }, [phase, hold, stillIndex, finish, findSeedTarget, handOff]);

  // The CSS version: two captions over a gathering cloud, then the Universe.
  useEffect(() => {
    if (phase !== 'fallback') return undefined;
    soundRef.current?.stop();
    soundRef.current = null;
    setSoundOn(false);
    const first = setTimeout(() => setCaption('Your world began before you knew it.'), 900);
    const second = setTimeout(() => setCaption('Every idea can change its shape.'), 3600);
    const hand = setTimeout(() => {
      handOff();
      rootRef.current?.classList.add('origin--dissolve');
    }, FALLBACK_MS - 900);
    const done = setTimeout(() => finish('failed'), FALLBACK_MS);
    captionRef.current?.style.setProperty('--o', '1');
    return () => {
      clearTimeout(first);
      clearTimeout(second);
      clearTimeout(hand);
      clearTimeout(done);
    };
  }, [phase, finish, handOff]);

  // The app asked us to step aside (a returning reader, or the Universe could not load).
  useEffect(() => {
    if (!dismiss || endedRef.current) return undefined;
    const quick = hold;
    setPhase('leaving');
    handOff();
    rootRef.current?.classList.add('origin--dissolve');
    if (quick) rootRef.current?.classList.add('origin--quick');
    const timer = setTimeout(() => finish(dismiss === 'returning' ? 'returning' : 'failed'), quick ? 220 : 500);
    return () => clearTimeout(timer);
    // `hold` is read once, when the app asks the opening to step aside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismiss, finish, handOff]);

  useEffect(() => {
    if (hold) return undefined;
    skipRef.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      // Focus rings appear only for someone using the keyboard; pointer viewers see a clean frame.
      rootRef.current?.classList.add('origin--keyboard');
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('skipped');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [finish, hold]);

  useEffect(() => () => {
    soundRef.current?.stop();
    soundRef.current = null;
  }, []);

  useEffect(() => {
    if (hold || !soundHint) return undefined;
    const timer = setTimeout(() => setSoundHint(false), 7500);
    return () => clearTimeout(timer);
  }, [hold, soundHint]);

  const toggleSound = () => {
    setSoundHint(false);
    if (soundOn) {
      soundRef.current?.stop();
      soundRef.current = null;
      setSoundOn(false);
      return;
    }
    const sound = new OriginSound();
    const t = phase === 'stills' ? (STILLS[stillIndex]?.t ?? 0) : clockRef.current.t;
    if (sound.start(t)) {
      soundRef.current = sound;
      setSoundOn(true);
    }
  };

  return (
    <div ref={rootRef} className={`origin origin--${phase}${hold ? ' origin--holding' : ''}`} data-testid="origin" aria-busy={hold || undefined}>
      <div ref={hostRef} className="origin-stage" aria-hidden="true" onClick={() => { if (!soundOn && !hold && phase !== 'fallback') toggleSound(); }}>
        {phase === 'fallback' && <div className="origin-fallback-cloud" />}
      </div>
      <section className="origin-copy" aria-label="Opening">
        <p className="visually-hidden">
          A short opening: an empty space, an expansion, the first stars, one star releasing material that gathers into new worlds,
          and then your own universe. Use Skip, or press Escape, to go straight in.
        </p>
        <p ref={captionRef} className="origin-caption" aria-live="polite">{caption}</p>
      </section>
      {!hold && soundHint && !soundOn && phase === 'playing' && (
        <p className="origin-sound-hint" aria-hidden="true">Tap anywhere for sound</p>
      )}
      {!hold && <div className="origin-controls">
        {phase !== 'fallback' && (
          <button type="button" className="origin-control origin-sound" aria-pressed={soundOn} onClick={toggleSound}>
            <svg viewBox="0 0 20 20" aria-hidden="true" className="origin-sound__icon">
              <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor" />
              {soundOn
                ? <path d="M13 7.2a4 4 0 0 1 0 5.6M15.2 5a7 7 0 0 1 0 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                : <path d="M13.5 7.5l4 5M17.5 7.5l-4 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
            </svg>
            {soundOn ? 'Sound on' : 'Sound off'}
          </button>
        )}
        {phase === 'stills' && STILLS[stillIndex] && (
          <button type="button" className="origin-control" onClick={() => setStillIndex(index => index + 1)}>
            Next
          </button>
        )}
        <button ref={skipRef} type="button" className="origin-control origin-skip" onClick={() => finish('skipped')}>
          Skip
        </button>
      </div>}
    </div>
  );
}
