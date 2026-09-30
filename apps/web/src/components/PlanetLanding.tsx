import { useEffect, useRef } from 'react';
import { CosmosBackground } from './CosmosBackground.tsx';
import { WorldGlobe } from './WorldGlobe.tsx';
import { ShipArtwork } from './TravelShip.tsx';
import './planet-landing.css';

interface PlanetLandingProps {
  title: string;
  saved: boolean;
  variant: number;
  onBack: () => void;
  onContinue: () => void;
}

/** The surface is a navigational view of an encounter, not a new inferred world. */
export function PlanetLanding({ title, saved, variant, onBack, onContinue }: PlanetLandingProps) {
  const heading = useRef<HTMLHeadingElement>(null);

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
        <button type="button" className="pill cream" onClick={onBack}>← Universe</button>
        <span className="eyebrow">KnowScroll / Landed</span>
      </header>
      <div className="planet-landing__scene">
        <div className="planet-landing__orbit" aria-hidden="true" />
        <button type="button" className="planet-landing__world" onClick={onContinue} aria-label={saved ? `Open saved Scroll: ${title}` : `Discover a Scroll from ${title}`}>
          <WorldGlobe variant={variant} />
          <span className="planet-landing__ship" aria-hidden="true"><svg viewBox="0 0 160 100"><ShipArtwork /></svg></span>
        </button>
        <div className="planet-landing__copy">
          <p className="planet-landing__eyebrow">{saved ? 'A path you kept' : 'A first landing'}</p>
          <h1 ref={heading} tabIndex={-1}>{title}</h1>
          <p>{saved ? 'A familiar encounter is waiting on the surface.' : 'There is more here to discover.'}</p>
          <button type="button" className="planet-landing__continue" onClick={onContinue}>
            {saved ? 'Open saved Scroll' : 'Discover a Scroll'} <span aria-hidden="true">↗</span>
          </button>
          <span className="planet-landing__hint">Tap the land to continue</span>
        </div>
      </div>
    </section>
  );
}
