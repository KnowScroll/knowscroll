import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CosmosBackground } from './CosmosBackground.tsx';
import { WorldGlobe } from './WorldGlobe.tsx';
import { ShipArtwork } from './TravelShip.tsx';
import './planet-landing.css';

interface PlanetLandingProps {
  title: string;
  /** What kind of world this is and where it sits ("A world inside Gravity"). */
  eyebrow: string;
  /** Its relationship to its star, in recorded terms. */
  lead: string;
  actionLabel: string;
  backLabel?: string;
  variant: number;
  onBack: () => void;
  onContinue: () => void;
  children?: ReactNode;
}

/** Landing on a world of a star (ADR-0049). The globe's cartography and light are illustration;
 * the world itself, its relation and the Scrolls the action opens are the reader's recorded state. */
export function PlanetLanding({ title, eyebrow, lead, actionLabel, backLabel = '← Universe', variant, onBack, onContinue, children }: PlanetLandingProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const world = useRef<HTMLButtonElement>(null);
  const rotation = useRef(variant % 2 === 0 ? 0 : 42);
  const pointer = useRef<{ id: number; x: number; startX: number; moved: boolean } | null>(null);
  const ignoreNextClick = useRef(false);
  const [light, setLight] = useState(0);
  const lightNames = ['Daylight', 'Evening glow', 'Moonlit'];

  const drawRotation = () => {
    const position = ((rotation.current % 200) + 200) % 200;
    world.current?.style.setProperty('--surface-shift', `${-position}px`);
  };

  const advanceLight = () => setLight(current => (current + 1) % lightNames.length);

  useEffect(() => {
    drawRotation();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (last && !pointer.current) {
        rotation.current += Math.min(now - last, 50) * .003;
        drawRotation();
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    pointer.current = { id: event.pointerId, x: event.clientX, startX: event.clientX, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointer.current;
    if (!drag || drag.id !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 5) drag.moved = true;
    rotation.current += (event.clientX - drag.x) * .65;
    drag.x = event.clientX;
    drawRotation();
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    ignoreNextClick.current = pointer.current.moved;
    pointer.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    pointer.current = null;
    ignoreNextClick.current = false;
  };

  useEffect(() => {
    heading.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  return (
    <section className="planet-landing" aria-label="Planet landing">
      <CosmosBackground />
      <header className="planet-landing__top">
        <button type="button" className="pill cream" onClick={onBack}>{backLabel}</button>
        <span className="eyebrow">KnowScroll / Landed</span>
      </header>
      <div className="planet-landing__scene">
        <div className="planet-landing__orbit" aria-hidden="true" />
        <div className="planet-landing__celestial">
          <div className="planet-landing__moon-track">
            <button type="button" className="planet-landing__moon" data-light={light} onClick={advanceLight} aria-label="Advance the moon and change the planet's light">
              <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="#fffbf0" /><circle cx="23" cy="23" r="5" fill="#c1c5d4" /><circle cx="42" cy="38" r="7" fill="#c1c5d4" /><circle cx="27" cy="44" r="3" fill="#c1c5d4" /><path className="planet-landing__moon-shade" d="M34 6a26 26 0 0 1 0 52c12-10 12-42 0-52Z" fill="#3c4583" /></svg>
            </button>
          </div>
          <button
            ref={world}
            type="button"
            className="planet-landing__world"
            data-light={light}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerCancel}
            onClick={() => { if (ignoreNextClick.current) { ignoreNextClick.current = false; return; } advanceLight(); }}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                rotation.current += event.key === 'ArrowLeft' ? -18 : 18;
                drawRotation();
              }
            }}
            aria-label={`Rotate planet ${title}; use arrow keys to turn, activate to change the light`}
          >
            <WorldGlobe variant={variant} />
            <span className="planet-landing__ship" aria-hidden="true"><svg viewBox="0 0 160 100"><ShipArtwork /></svg></span>
          </button>
          <span className="planet-landing__light" aria-live="polite">{lightNames[light]}</span>
        </div>
        <div className="planet-landing__copy">
          <p className="planet-landing__eyebrow">{eyebrow}</p>
          <h1 ref={heading} tabIndex={-1}>{title}</h1>
          <p>{lead}</p>
          {children}
          <button type="button" className="planet-landing__continue" onClick={onContinue}>
            {actionLabel} <span aria-hidden="true">↗</span>
          </button>
          <span className="planet-landing__hint">Drag to turn · Tap the planet or moon to change the light</span>
        </div>
      </div>
    </section>
  );
}
