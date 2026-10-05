import type { CSSProperties } from 'react';

export interface TravelDestination {
  x: number;
  y: number;
}

/** One small, code-native ship illustration shared by flight and arrival. */
export function ShipArtwork() {
  return <>
    <path d="M80 4 100 42 146 65 151 78 112 73 100 89 80 82 60 89 48 73 9 78 14 65 60 42Z" fill="#fffbf0" stroke="#111214" strokeWidth="3" strokeLinejoin="round" />
    <path d="M80 4 100 42 146 65 112 61 80 47 48 61 14 65 60 42Z" fill="#2c46e8" stroke="#111214" strokeWidth="2" strokeLinejoin="round" />
    <path d="M80 20 88 47 80 58 72 47Z" fill="#14c79b" stroke="#111214" strokeWidth="2" />
    <path d="M24 67 49 63 53 72 17 75M136 67 111 63 107 72 143 75" fill="#ffe44d" stroke="#111214" strokeWidth="2" />
    <path d="M66 84 64 98 72 89M94 84 96 98 88 89" fill="#55e4ff" stroke="#111214" strokeWidth="1.5" />
  </>;
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
      <svg className="travel-ship" viewBox="0 0 160 100" role="img" aria-label="A spaceship travelling through the starfield" style={style}>
        <ShipArtwork />
      </svg>
    </div>
  );
}
