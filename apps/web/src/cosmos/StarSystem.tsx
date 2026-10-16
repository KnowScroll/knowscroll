import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SkySurface } from './SkySurface.tsx';
import { worldOrbits } from './skyLayout.ts';
import { CONDITION_LABEL, type StarView, type StarWorld, type UniverseSky } from './starView.ts';

export interface StarSystemProps {
  star: StarView;
  sky: UniverseSky;
  reducedMotion: boolean;
  /** Screen point the reader tapped, so the approach grows out of the star they chose. */
  from: { x: number; y: number } | null;
  settingAside: boolean;
  onClose: () => void;
  onOpenStar: (placeId: string) => void;
  onLand: (world: StarWorld) => void;
  onReadFrom?: (placeId: string, name: string) => void;
  onSetAside?: (placeId: string) => void;
  onEnterScroll: () => void;
}

const ORBIT_SCALE = 17; // % of the orrery's square field per orbit unit
const ORBIT_TILT = 0.58; // how open the orbits look from the reader's viewpoint

/**
 * Approaching one star (ADR-0049): the star at the centre, its worlds on their orbits, its
 * possibilities as faint motes, and a cream sheet that says why it looks the way it does, in
 * recorded facts. Worlds are doors: landing on one leads to real Scrolls from it.
 */
export function StarSystem({ star, sky, reducedMotion, from, settingAside, onClose, onOpenStar, onLand, onReadFrom, onSetAside, onEnterScroll }: StarSystemProps) {
  const orreryRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [starRadius, setStarRadius] = useState(40);
  const [confirmingAside, setConfirmingAside] = useState(false);
  const [mode, setMode] = useState<'gl' | 'css'>('css');
  const orbits = useMemo(() => worldOrbits(star), [star]);
  const nameOf = (placeId: string) => sky.stars.find(item => item.placeId === placeId)?.name ?? null;

  // The star is drawn in proportion to the field, so a phone shows the same system, smaller.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setStarRadius(Math.round(Math.max(20, Math.min(42, field.offsetWidth * 0.052)))));
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  // Focus moves to the star's name once per star approached; Escape always uses the latest close.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [star.placeId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const approach = !reducedMotion && from
    ? ({ '--approach-x': `${from.x}px`, '--approach-y': `${from.y}px` } as CSSProperties)
    : undefined;
  const connectedStars = [...new Set(star.connections.map(item => item.otherStarId).filter((id): id is string => !!id))];

  return (
    <section className={`star-system${approach ? ' is-approaching' : ''}`} style={approach} aria-label={`${star.name}, a star in your universe`} data-sky-mode={mode}>
      <div className="star-system__orrery" ref={orreryRef}>
        <SkySurface anchors={orreryRef} reducedMotion={reducedMotion} onMode={setMode} />
        <div className="star-system__field" ref={fieldRef}>
        <svg className="star-system__orbits" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {[...new Set(orbits.map(item => item.orbit))].map(orbit => (
            <ellipse key={orbit} cx="50" cy="50" rx={orbit * ORBIT_SCALE} ry={orbit * ORBIT_SCALE * ORBIT_TILT} />
          ))}
          <ellipse className="star-system__halo" cx="50" cy="50" rx={2.55 * ORBIT_SCALE} ry={2.55 * ORBIT_SCALE * ORBIT_TILT} />
        </svg>
        <div className="star-system__star sky-body" data-sky="star" data-condition={star.condition} data-radius={starRadius} data-seed="0.37" data-emphasis="1">
          <span className="sky-body__css sky-body__css--star" data-condition={star.condition} aria-hidden="true" />
        </div>
        {star.worlds.map((world, i) => {
          const place = orbits[i]!;
          const left = inField(50 + Math.cos(place.angle) * place.orbit * ORBIT_SCALE);
          const top = 50 + Math.sin(place.angle) * place.orbit * ORBIT_SCALE * ORBIT_TILT;
          const name = world.kind === 'facet' ? world.name : world.question;
          return (
            <button
              key={world.id}
              type="button"
              className={`star-system__world sky-body world-${world.kind}`}
              style={{ left: `${left}%`, top: `${top}%` }}
              data-sky="world"
              data-world={world.kind}
              data-radius={world.kind === 'facet' ? 15 : 12}
              data-seed={(0.13 + i * 0.29) % 1}
              onClick={() => onLand(world)}
              aria-label={world.kind === 'facet' ? `Land on ${world.name}, a world inside ${star.name}` : `Land on the question world: ${world.question}`}
            >
              <span className="sky-body__css sky-body__css--world" data-world={world.kind} aria-hidden="true" />
              <span className="sky-label">
                <span className="sky-label__name">{shorten(name, 34)}</span>
                <span className="sky-label__sub">{world.kind === 'facet' ? 'A world' : 'A question'}</span>
              </span>
            </button>
          );
        })}
        {star.possibilities.slice(0, 6).map((possibility, i) => {
          const angle = -Math.PI * 0.15 + i * (Math.PI * 2 / Math.max(6, star.possibilities.length)) + 0.5;
          const left = inField(50 + Math.cos(angle) * 2.55 * ORBIT_SCALE);
          const top = 50 + Math.sin(angle) * 2.55 * ORBIT_SCALE * ORBIT_TILT;
          return (
            <span key={possibility.placeId} className="star-system__possibility" style={{ left: `${left}%`, top: `${top}%` }}>
              <span className="star-system__mote" aria-hidden="true" />
              <span className="sky-label sky-label--faint">
                <span className="sky-label__name">{possibility.name}</span>
              </span>
            </span>
          );
        })}
        </div>
      </div>

      <aside className="star-sheet" aria-labelledby="star-sheet-title">
        <button type="button" className="pill cream star-sheet__back" onClick={onClose}>‹ Universe</button>
        <p className={`star-sheet__condition is-${star.condition}`}>{CONDITION_LABEL[star.condition]}</p>
        <h2 id="star-sheet-title" ref={headingRef} tabIndex={-1}>{star.name}</h2>
        <p className="star-sheet__description">{star.description}</p>
        {onReadFrom ? (
          <button type="button" className="pill teal star-sheet__read" onClick={() => onReadFrom(star.placeId, star.name)}>
            Read from {star.name}
          </button>
        ) : (
          <button type="button" className="pill teal star-sheet__read" onClick={onEnterScroll}>Enter Scroll</button>
        )}

        <section className="star-sheet__section" aria-labelledby="star-why">
          <h3 id="star-why">Why it looks like this</h3>
          <ul className="star-sheet__reasons">
            {star.reasons.map((reason, i) => <li key={`${reason.kind}-${i}`} data-kind={reason.kind}>{reason.text}</li>)}
          </ul>
        </section>

        {star.worlds.length > 0 && (
          <section className="star-sheet__section" aria-labelledby="star-worlds">
            <h3 id="star-worlds">Worlds inside {star.name}</h3>
            <ul className="star-sheet__worlds">
              {star.worlds.map(world => (
                <li key={world.id} className={`star-world-card is-${world.kind}`}>
                  <p className="star-world-card__kind">{world.kind === 'facet' ? 'A world' : world.state === 'arguing' ? 'A question, argued' : 'A question'}</p>
                  <p className="star-world-card__name">{world.kind === 'facet' ? world.name : `“${shorten(world.question, 160)}”`}</p>
                  <p className="star-world-card__relation">{world.relation}</p>
                  {world.kind === 'question' && world.positions.length > 0 && (
                    <ul className="star-world-card__positions">
                      {world.positions.map(position => (
                        <li key={position.role}>
                          <span>{position.label}</span>
                          {position.claims.map(claim => <q key={claim.key}>{claim.statement}</q>)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="star-world-card__actions">
                    <button type="button" className="star-sheet__text-button" onClick={() => onLand(world)}>Land here</button>
                    {onReadFrom && (
                      <button type="button" className="star-sheet__text-button" onClick={() => onReadFrom(world.placeId, world.kind === 'facet' ? world.name : world.placeName)}>
                        Read from {world.kind === 'facet' ? world.name : world.placeName}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {star.possibilities.length > 0 && (
          <section className="star-sheet__section" aria-labelledby="star-possibilities">
            <h3 id="star-possibilities">At its edge, not met yet</h3>
            <ul className="star-sheet__possibilities">
              {star.possibilities.map(possibility => (
                <li key={possibility.placeId}>
                  <strong>{possibility.name}</strong>
                  <span>{possibility.phrase}</span>
                  {possibility.claim && <q>{possibility.claim}</q>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {star.connections.length > 0 && (
          <section className="star-sheet__section" aria-labelledby="star-connections">
            <h3 id="star-connections">Connections</h3>
            <ul className="star-sheet__connections">
              {star.connections.map(connection => (
                <li key={connection.key} className={connection.tension ? 'is-tension' : undefined}>
                  <span>{connection.sentence}</span>
                  {connection.support && <q>{connection.support}</q>}
                </li>
              ))}
            </ul>
            {connectedStars.length > 0 && (
              <div className="star-sheet__links">
                {connectedStars.map(id => {
                  const name = nameOf(id);
                  return name ? <button key={id} type="button" className="star-sheet__text-button" onClick={() => onOpenStar(id)}>Go to {name}</button> : null;
                })}
              </div>
            )}
          </section>
        )}

        {star.chronicle.length > 0 && (
          <section className="star-sheet__section" aria-labelledby="star-changes">
            <h3 id="star-changes">What changed, as it happened</h3>
            <ol className="star-sheet__chronicle">
              {star.chronicle.slice(0, 5).map(entry => (
                <li key={entry.deltaId}>
                  <time dateTime={entry.at}>{new Date(entry.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
                  <span>{entry.line}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {onSetAside && !confirmingAside && (
          <button type="button" className="star-sheet__set-aside" disabled={settingAside} onClick={() => setConfirmingAside(true)}>
            {settingAside ? 'Setting aside…' : 'Set this star aside'}
          </button>
        )}
        {onSetAside && confirmingAside && (
          <div className="star-sheet__confirm" role="group" aria-label={`Set ${star.name} aside?`}>
            <p>Set {star.name} aside? It will not form again unless you clear your history; any narrower world inside it becomes a star of its own.</p>
            <div className="star-world-card__actions">
              <button type="button" className="star-sheet__text-button is-danger" onClick={() => { setConfirmingAside(false); onSetAside(star.placeId); }}>Set it aside</button>
              <button type="button" className="star-sheet__text-button" onClick={() => setConfirmingAside(false)}>Keep it</button>
            </div>
          </div>
        )}
      </aside>
    </section>
  );
}

/** Labels are centred on their body; keep the body far enough from the field's edge for its label. */
function inField(left: number): number {
  return Math.max(16, Math.min(84, left));
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
