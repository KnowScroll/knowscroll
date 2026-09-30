import type { CSSProperties } from 'react';

export interface TravelDestination {
  x: number;
  y: number;
}

/** Decorative transition shown only while entering a Scroll or reopening a Trace. */
export function TravelShip({ destination }: { destination: TravelDestination }) {
  const targetX = Math.max(0, Math.min(100, (destination.x / window.innerWidth) * 100));
  const targetY = Math.max(0, Math.min(100, (destination.y / window.innerHeight) * 100));
  const style = {
    '--travel-dx': `${destination.x - window.innerWidth / 2}px`,
    '--travel-dy': `${destination.y - window.innerHeight * 0.88}px`,
  } as CSSProperties;

  return (
    <div className="travel-overlay" role="status" aria-live="polite" aria-label="Travelling to your destination">
      <svg className="travel-trail" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d={`M50 88 Q${50 + (targetX - 50) * 0.35} ${88 + (targetY - 88) * 0.6} ${targetX} ${targetY}`} />
      </svg>
      <svg className="travel-ship" viewBox="0 0 120 100" role="img" aria-label="A small spaceship travelling through the starfield" style={style}>
        <defs>
          <linearGradient id="travel-hull" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fffdf2" />
            <stop offset="1" stopColor="#9bd8dd" />
          </linearGradient>
          <radialGradient id="travel-window">
            <stop offset="0" stopColor="#d7fff7" />
            <stop offset="1" stopColor="#2c9c9d" />
          </radialGradient>
        </defs>
        <path d="M60 5 C74 20 83 40 85 64 L60 82 35 64 C37 40 46 20 60 5Z" fill="url(#travel-hull)" stroke="#fffdf2" strokeWidth="2" />
        <path d="M60 28 C70 35 73 46 72 55 L60 63 48 55 C47 46 50 35 60 28Z" fill="url(#travel-window)" stroke="#176f79" strokeWidth="2" />
        <path d="M37 55 16 72 38 75M83 55 104 72 82 75" fill="#2dc9bf" stroke="#d8fff7" strokeWidth="2" strokeLinejoin="round" />
        <path d="M50 74 55 96 60 85 65 96 70 74Z" fill="#ffcf68" opacity=".95" />
      </svg>
      <span className="travel-caption">Setting course</span>
    </div>
  );
}
