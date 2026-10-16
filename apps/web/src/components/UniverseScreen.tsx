import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Trace, Universe } from '../api/types.ts';
import type { SkyView, UniverseView } from '../state/readerStore.ts';
import type { ReaderStorage } from '../state/storage.ts';
import { CosmosBackground } from './CosmosBackground.tsx';
import { PlanetLanding } from './PlanetLanding.tsx';
import { TravelShip, type TravelDestination } from './TravelShip.tsx';
import { SkySurface } from '../cosmos/SkySurface.tsx';
import { StarSystem } from '../cosmos/StarSystem.tsx';
import { keptSlots, STAR_RADIUS, starSlots } from '../cosmos/skyLayout.ts';
import { CONDITION_LABEL, deriveSky, starCaption, type StarWorld, type Transformation, type UniverseSky } from '../cosmos/starView.ts';
import '../cosmos/sky.css';

export interface UniverseScreenProps {
  state: UniverseView;
  storage: ReaderStorage;
  sky?: SkyView;
  reducedMotion?: boolean;
  onEnterScroll: () => void;
  onEnterTestReels?: () => void;
  onEnterRichScrolls?: () => void;
  onOpenTrace: (trace: Trace) => void;
  onEnterSystem: () => void;
  onOpenPrivacy: () => void;
  onOpenKeep?: () => void;
  onRetry: () => void;
  onRetrySky?: () => void;
  onReadFrom?: (placeId: string, name: string) => void;
  onSetAside?: (placeId: string) => void;
  onReplayOrigin?: () => void;
}

/** The Universe: the reader's stars (ADR-0049) on the far sky, their kept lights, and — before any
 * star has formed — the unformed cloud the opening ends on, with the first discovery in reach. */
export function UniverseScreen({ state, storage, sky = { status: 'idle' }, reducedMotion = false, onEnterScroll, onEnterTestReels, onEnterRichScrolls, onOpenTrace, onEnterSystem, onOpenPrivacy, onOpenKeep, onRetry, onRetrySky, onReadFrom, onSetAside, onReplayOrigin }: UniverseScreenProps) {
  return (
    <main className="universe-screen" aria-label="Universe">
      {state.status !== 'loaded' && <CosmosBackground />}
      {state.status === 'loading' && (
        <div className="universe-content">
          <p className="eyebrow">KNOWSCROLL</p>
          <h1>Your universe</h1>
          <p role="status" aria-live="polite">
            Loading your universe…
          </p>
        </div>
      )}
      {state.status === 'unavailable' && (
        <div className="universe-content">
          <p className="eyebrow">KNOWSCROLL</p>
          <h1>Your universe</h1>
          <div className="unavailable-block" role="alert">
            <h2>The universe is unavailable</h2>
            <p>The bootstrap service could not be reached, or this session is no longer valid.</p>
            <p className="detail">{state.message}</p>
            <button type="button" className="pill orange" onClick={onRetry} aria-label="Retry loading the universe">
              Retry
            </button>
          </div>
        </div>
      )}
      {state.status === 'loaded' && (
        <LoadedUniverse
          universe={state.universe}
          storage={storage}
          sky={sky}
          reducedMotion={reducedMotion}
          onEnterScroll={onEnterScroll}
          onEnterTestReels={onEnterTestReels}
          onEnterRichScrolls={onEnterRichScrolls}
          onOpenTrace={onOpenTrace}
          onEnterSystem={onEnterSystem}
          onOpenPrivacy={onOpenPrivacy}
          onOpenKeep={onOpenKeep}
          onRetrySky={onRetrySky}
          onReadFrom={onReadFrom}
          onSetAside={onSetAside}
          onReplayOrigin={onReplayOrigin}
        />
      )}
    </main>
  );
}

/** Copy varies with what has formed; these are descriptions of real state, not levels. */
type Stage = 'first' | 'few' | 'stars';

interface LoadedUniverseProps {
  universe: Universe;
  storage: ReaderStorage;
  sky: SkyView;
  reducedMotion: boolean;
  onEnterScroll: () => void;
  onEnterTestReels?: () => void;
  onEnterRichScrolls?: () => void;
  onOpenTrace: (trace: Trace) => void;
  onEnterSystem: () => void;
  onOpenPrivacy: () => void;
  onOpenKeep?: () => void;
  onRetrySky?: () => void;
  onReadFrom?: (placeId: string, name: string) => void;
  onSetAside?: (placeId: string) => void;
  onReplayOrigin?: () => void;
}

type Landing = { world: StarWorld; starId: string };

function LoadedUniverse({ universe, storage, sky, reducedMotion, onEnterScroll, onEnterTestReels, onEnterRichScrolls, onOpenTrace, onEnterSystem, onOpenPrivacy, onOpenKeep, onRetrySky, onReadFrom, onSetAside, onReplayOrigin }: LoadedUniverseProps) {
  const traces = universe.traces;
  const derived: UniverseSky | null = useMemo(() => (sky.status === 'loaded' ? deriveSky(sky.response) : null), [sky]);
  const stars = derived?.stars ?? [];
  const stage: Stage = stars.length > 0 ? 'stars' : traces.length > 0 ? 'few' : 'first';
  const firstBodyRef = useRef<HTMLButtonElement | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  const bodiesRef = useRef<HTMLDivElement | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const [travel, setTravel] = useState<TravelDestination | null>(null);
  const [skyMode, setSkyMode] = useState<'gl' | 'css'>('css');
  const [selected, setSelected] = useState<{ starId: string; from: { x: number; y: number } | null } | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [portrait, setPortrait] = useState(() => typeof window !== 'undefined' && window.innerHeight > window.innerWidth);
  const pendingAction = useRef<(() => void) | null>(null);
  const travelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressPointerClick = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const resize = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => () => {
    if (travelTimer.current) clearTimeout(travelTimer.current);
    if (suppressTimer.current) clearTimeout(suppressTimer.current);
    pendingAction.current = null;
  }, []);

  useEffect(() => {
    if (!travel) return undefined;
    travelTimer.current = setTimeout(() => {
      const action = pendingAction.current;
      pendingAction.current = null;
      setTravel(null);
      action?.();
    }, 950);
    return () => {
      if (travelTimer.current) clearTimeout(travelTimer.current);
      travelTimer.current = null;
    };
  }, [travel]);

  // ADR-0049 §4: the newest recorded change this browser has not drawn yet plays once on its star.
  // Which ids were drawn is local display memory in the reader's own (purged) storage, never
  // evidence. A browser's first sight of this sky draws nothing: it cannot know what is recent.
  const [event, setEvent] = useState<{ transformation: Transformation; startedAt: number } | null>(null);
  useEffect(() => {
    if (!derived) return undefined;
    const known = storage.readSkyPlayed(universe.universeId);
    const played = known ?? new Set<string>();
    const fresh = known ? derived.transformations.find(item => item.starId !== null && item.kind !== 'quiet_change' && !played.has(item.id)) : undefined;
    for (const item of derived.transformations) played.add(item.id);
    storage.writeSkyPlayed(universe.universeId, played);
    if (fresh) setEvent({ transformation: fresh, startedAt: performance.now() });
    return undefined;
  }, [derived, storage, universe.universeId]);
  useEffect(() => {
    if (!event) return undefined;
    const timer = setTimeout(() => setEvent(null), 9000);
    return () => clearTimeout(timer);
  }, [event]);

  // A star that was set aside, or a sky that changed underneath, closes what no longer exists.
  useEffect(() => {
    if (selected && !stars.some(star => star.placeId === selected.starId)) setSelected(null);
  }, [selected, stars]);

  /** Leaving a star returns focus to the star the reader approached. */
  const closeSystem = useCallback(() => {
    const id = selected?.starId;
    setSelected(null);
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-place-id="${id}"]`)?.focus());
  }, [selected?.starId]);

  /** The ship flies to what the reader chose, then the action runs (instantly under reduced motion). */
  const flyTo = (event: ReactMouseEvent<HTMLElement>, action: () => void) => {
    if (reducedMotion) {
      action();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    pendingAction.current = action;
    setTravel({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  };

  const navigateNow = (action: () => void) => {
    pendingAction.current = null;
    if (travelTimer.current) clearTimeout(travelTimer.current);
    setTravel(null);
    action();
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: camera.x, startY: camera.y, moved: false };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (Math.abs(dx) + Math.abs(dy) > 7) active.moved = true;
    if (!active.moved) return;
    setDragging(true);
    const bounds = event.currentTarget.getBoundingClientRect();
    const rangeX = Math.min(620, bounds.width * 0.9);
    const rangeY = Math.min(620, bounds.height * 0.9);
    setCamera(value => ({ ...value, x: clamp(active.startX + dx, -rangeX, rangeX), y: clamp(active.startY + dy, -rangeY, rangeY) }));
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.moved) {
      suppressPointerClick.current = true;
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
      suppressTimer.current = setTimeout(() => { suppressPointerClick.current = false; }, 450);
    }
    drag.current = null;
    setDragging(false);
  };

  const blockDragClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.detail > 0 && suppressPointerClick.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressPointerClick.current = false;
      if (suppressTimer.current) clearTimeout(suppressTimer.current);
    }
  };

  const adjustZoom = (amount: number) => setCamera(value => ({ ...value, zoom: Math.max(0.7, Math.min(1.8, Math.round((value.zoom + amount) * 100) / 100)) }));

  const focusKeep = () => {
    if (firstBodyRef.current) firstBodyRef.current.focus();
    else ctaRef.current?.focus();
  };

  // The real why-this-appeared reason for the most recently kept Trace (never a fabricated
  // growth claim). Only trusted within the same universe/privacy scope as what is loaded.
  const growthNote = useMemo(() => {
    if (stage === 'stars') {
      const latest = derived?.transformations.find(item => item.kind !== 'quiet_change');
      return latest ? latest.line : null;
    }
    if (stage !== 'few') return null;
    const stored = storage.readLastKept();
    if (!stored || stored.universeId !== universe.universeId || stored.privacyEpoch !== universe.privacyEpoch) return null;
    const reason = stored.reason.trim();
    return reason.length > 0 ? reason : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, storage, universe.universeId, universe.privacyEpoch, traces.length, derived]);

  const starSlotList = useMemo(() => starSlots(stars.length, portrait), [stars.length, portrait]);
  const keptSlotList = useMemo(() => keptSlots(traces.length, stars.length > 0), [traces.length, stars.length]);
  const slotOf = useCallback((placeId: string) => {
    const index = stars.findIndex(star => star.placeId === placeId);
    return index >= 0 ? starSlotList[index] : undefined;
  }, [stars, starSlotList]);

  const selectedStar = selected ? stars.find(star => star.placeId === selected.starId) ?? null : null;
  const landingStar = landing ? stars.find(star => star.placeId === landing.starId) ?? null : null;

  if (landing && landingStar) {
    const world = landing.world;
    const readPlace = world.kind === 'facet' ? { id: world.placeId, name: world.name } : { id: world.placeId, name: world.placeName };
    return <PlanetLanding
      title={world.kind === 'facet' ? world.name : shorten(world.question, 110)}
      eyebrow={world.kind === 'facet' ? `A world inside ${landingStar.name}` : `A question world in ${world.placeName}`}
      lead={world.relation}
      actionLabel={onReadFrom ? `Read from ${readPlace.name}` : 'Enter Scroll'}
      backLabel={`‹ ${landingStar.name}`}
      variant={world.kind === 'facet' ? 0 : 1}
      onBack={() => setLanding(null)}
      onContinue={() => {
        setLanding(null);
        if (onReadFrom) onReadFrom(readPlace.id, readPlace.name);
        else onEnterScroll();
      }}
    >
      {world.kind === 'question' && world.positions.length > 0 && (
        <ul className="landing-positions">
          {world.positions.map(position => (
            <li key={position.role}><span>{position.label}</span>{position.claims.slice(0, 1).map(claim => <q key={claim.key}>{claim.statement}</q>)}</li>
          ))}
        </ul>
      )}
    </PlanetLanding>;
  }

  if (selectedStar && derived) {
    return <>
      <CosmosBackground />
      <StarSystem
        star={selectedStar}
        sky={derived}
        reducedMotion={reducedMotion}
        from={selected?.from ?? null}
        settingAside={sky.status === 'loaded' && sky.settingAside === selectedStar.placeId}
        onClose={closeSystem}
        onOpenStar={placeId => setSelected({ starId: placeId, from: null })}
        onLand={world => setLanding({ world, starId: selectedStar.placeId })}
        onReadFrom={onReadFrom}
        onSetAside={onSetAside}
        onEnterScroll={onEnterScroll}
      />
    </>;
  }

  // Without the sky we cannot tell a new universe from one whose stars failed to load: say neither.
  const skyMissing = sky.status === 'unavailable' && stage !== 'stars';
  const heading = skyMissing
    ? 'Your universe.'
    : stage === 'first'
    ? 'Somewhere new starts here.'
    : stage === 'few'
      ? 'Your curiosity leaves a trace.'
      : stars.length === 1 ? `A first star: ${stars[0]!.name}.` : 'Your sky, so far.';
  const subtitle = skyMissing
    ? 'Everything else here still works: the Cable, Keep and your kept Scrolls.'
    : stage === 'first'
    ? 'No topics to pick. Just something interesting.'
    : stage === 'few'
      ? 'Stars form from topics you keep, ask about or follow on more than one day.'
      : skySubtitle(derived!);

  return (
    <>
      <CosmosBackground camera={camera} />
      <div className="universe-title" aria-hidden="false">
        <p className="eyebrow">KNOWSCROLL</p>
        <h1>{heading}</h1>
        <p className="universe-subtitle">{subtitle}</p>
        {event ? (
          <p className="growth-caption sky-event-caption" role="status">
            <span className="sky-event-caption__kicker">Just changed</span> {event.transformation.line}
          </p>
        ) : growthNote && <p className="growth-caption">{growthNote}</p>}
        {sky.status === 'unavailable' && (
          <p className="sky-unavailable" role="status">
            Your stars could not be loaded. <button type="button" className="sky-text-button" onClick={onRetrySky}>Try again</button>
          </p>
        )}
      </div>

      <div className="universe-corner">
        {onReplayOrigin && (
          <button type="button" className="pill ghost origin-replay" onClick={() => navigateNow(onReplayOrigin)} aria-label="Replay the opening">
            ↺ Opening
          </button>
        )}
        <button type="button" className="pill cream privacy-entry" onClick={() => navigateNow(onOpenPrivacy)} aria-label="Open privacy controls">
          Privacy
        </button>
      </div>

      <SkySurface anchors={bodiesRef} reducedMotion={reducedMotion} onMode={setSkyMode} className="universe-sky" />

      <div className={`universe-camera${dragging ? ' is-dragging' : ''}`} data-sky-mode={skyMode} aria-label="Explore the starfield. Drag to move, use arrow keys or pan controls, and use plus or minus to zoom." onPointerDown={beginPan} onPointerMove={pan} onPointerUp={endPan} onPointerCancel={endPan} onClickCapture={blockDragClick} onKeyDown={event => {
        const step = event.shiftKey ? 120 : 60;
        if (event.key === 'ArrowLeft') setCamera(value => ({ ...value, x: Math.min(620, value.x + step) }));
        else if (event.key === 'ArrowRight') setCamera(value => ({ ...value, x: Math.max(-620, value.x - step) }));
        else if (event.key === 'ArrowUp') setCamera(value => ({ ...value, y: Math.min(620, value.y + step) }));
        else if (event.key === 'ArrowDown') setCamera(value => ({ ...value, y: Math.max(-620, value.y - step) }));
        else return;
        event.preventDefault();
      }} tabIndex={0}>
      <div className="universe-bodies" ref={bodiesRef} style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})` }}>
        {derived && derived.constellations.length > 0 && (
          <svg className="sky-constellations" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {derived.constellations.map(line => {
              const a = slotOf(line.fromStarId);
              const b = slotOf(line.toStarId);
              if (!a || !b) return null;
              return <line key={line.key} x1={a.left} y1={a.top} x2={b.left} y2={b.top} className={line.tension ? 'is-tension' : undefined} />;
            })}
          </svg>
        )}

        {stage !== 'stars' && (
          <>
            <button
              type="button"
              className="body-button seed sky-body"
              style={bodyStyle(50, 50, 132)}
              data-sky="seed"
              data-radius="70"
              data-origin-target=""
              onClick={event => flyTo(event, onEnterScroll)}
              aria-label="A first possibility: see what catches your curiosity"
              ref={traces.length === 0 ? firstBodyRef : undefined}
            >
              <span className="sky-body__css sky-body__css--seed" aria-hidden="true" />
              <span className="body-label">
                <span className="body-name">A first possibility</span>
                <span className="body-sub">{traces.length === 0 ? 'See what catches your curiosity' : 'Still gathering'}</span>
              </span>
            </button>
            {traces.length === 0 && (
              <>
                <button type="button" className="body-button dust sky-body" style={bodyStyle(20, 32, 40)} data-sky="frontier" data-radius="26" onClick={event => flyTo(event, onEnterScroll)} aria-label="A different angle">
                  <span className="body-label"><span className="body-name">A different angle</span></span>
                </button>
                <button type="button" className="body-button dust sky-body" style={bodyStyle(80, 26, 36)} data-sky="frontier" data-radius="22" onClick={event => flyTo(event, onEnterScroll)} aria-label="A little surprise">
                  <span className="body-label"><span className="body-name">A little surprise</span></span>
                </button>
              </>
            )}
          </>
        )}

        {stars.length > 0 && (
          <nav aria-label="Your stars" className="universe-bodies-nav">
            <ul>
              {stars.map((star, i) => {
                const slot = starSlotList[i] ?? { left: 50, top: 50 };
                const radius = STAR_RADIUS[star.condition] * (i === 0 ? 1.2 : 1);
                return (
                  <li key={star.placeId}>
                    <button
                      type="button"
                      className={`body-button sky-star sky-body is-${star.condition}`}
                      style={bodyStyle(slot.left, slot.top, radius * 2.6)}
                      data-sky="star"
                      data-place-id={star.placeId}
                      data-condition={star.condition}
                      data-radius={radius}
                      data-seed={(0.17 + i * 0.31) % 1}
                      data-worlds={star.worlds.length}
                      data-motes={star.possibilities.length}
                      data-emphasis={i === 0 ? '1' : '0'}
                      data-event={!reducedMotion && event?.transformation.starId === star.placeId ? event.transformation.kind : undefined}
                      data-event-at={!reducedMotion && event?.transformation.starId === star.placeId ? event.startedAt : undefined}
                      ref={i === 0 ? firstBodyRef : undefined}
                      onClick={event => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setSelected({ starId: star.placeId, from: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } });
                      }}
                      aria-label={`${star.name}: ${CONDITION_LABEL[star.condition].toLowerCase()}. ${starCaption(star)}. Approach this star.`}
                    >
                      <span className="sky-body__css sky-body__css--star" data-condition={star.condition} aria-hidden="true" />
                      <span className="body-label">
                        <span className="body-name">{star.name}</span>
                        <span className="body-sub">{starCaption(star)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {traces.length > 0 && (
          <nav aria-label="Saved Traces" className="universe-bodies-nav">
            <ul>
              {traces.map((trace, i) => {
                const slot = keptSlotList[i] ?? { left: 50, top: 88 };
                return (
                  <li key={trace.eventId}>
                    <button
                      type="button"
                      className={`body-button trace kept-light${stage === 'stars' ? ' is-quiet' : ''}`}
                      style={bodyStyle(slot.left, slot.top, 22)}
                      onClick={event => flyTo(event, () => onOpenTrace(trace))}
                      aria-label={`Revisit the saved Trace: ${trace.title || 'Saved Scroll unavailable'}`}
                      ref={stars.length === 0 && i === 0 ? firstBodyRef : undefined}
                    >
                      <span className="kept-light__spark" aria-hidden="true" />
                      <span className="body-label">
                        <span className="body-name">{trace.title || 'Saved Scroll unavailable'}</span>
                        <span className="body-sub">{formatTraceDate(trace.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {stage === 'stars' && (
          <button type="button" className="body-button nebula sky-body frontier" style={bodyStyle(portrait ? 82 : 90, portrait ? 74 : 70, 64)} data-sky="frontier" data-radius="56" onClick={event => flyTo(event, onEnterScroll)} aria-label="Still unexplored">
            <span className="body-label">
              <span className="body-name">Still unexplored</span>
            </span>
          </button>
        )}
      </div>
      </div>

      {(stage === 'stars' || traces.length > 0) && (
        <div className="universe-legend" aria-hidden="true">
          {stage === 'stars' && <span><i className="legend-star" /> A topic of yours</span>}
          {traces.length > 0 && <span><i className="legend-dot" /> Kept</span>}
          <span><i className="legend-ring" /> Still unexplored</span>
        </div>
      )}

      <div className={`map-tools${stage === 'first' ? '' : ' has-traces'}${camera.x !== 0 || camera.y !== 0 || camera.zoom !== 1 ? ' is-moved' : ''}`} aria-label="Map controls">
        <div className="pan-controls" role="group" aria-label="Pan the universe">
          <button type="button" className="zoom-button" onClick={() => setCamera(value => ({ ...value, y: Math.min(620, value.y + 70) }))} aria-label="Pan up">↑</button>
          <button type="button" className="zoom-button" onClick={() => setCamera(value => ({ ...value, x: Math.min(620, value.x + 70) }))} aria-label="Pan left">←</button>
          <button type="button" className="zoom-button" onClick={() => setCamera(value => ({ ...value, y: Math.max(-620, value.y - 70) }))} aria-label="Pan down">↓</button>
          <button type="button" className="zoom-button" onClick={() => setCamera(value => ({ ...value, x: Math.max(-620, value.x - 70) }))} aria-label="Pan right">→</button>
        </div>
        <button type="button" className="zoom-button" disabled={camera.zoom <= 0.7} onClick={() => adjustZoom(-0.15)} aria-label="Zoom out">−</button>
        <button type="button" className="zoom-button" disabled={camera.zoom >= 1.8} onClick={() => adjustZoom(0.15)} aria-label="Zoom in">+</button>
        <button type="button" className="zoom-button recenter" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })} aria-label="Recenter the universe">⌖</button>
      </div>
      {travel && <TravelShip destination={travel} />}

      <p className="universe-hint">{stage === 'stars' ? 'Drag to explore · Tap a star to approach it' : 'Drag to explore · Tap the cloud to begin'}</p>

      <div className="universe-cta-block">
        <button
          type="button"
          className={stage === 'first' ? 'pill yellow universe-cta' : 'pill teal universe-cta'}
          onClick={() => navigateNow(onEnterScroll)}
          aria-label="Enter Scroll"
          ref={stage === 'first' ? undefined : ctaRef}
        >
          {stage === 'first' ? 'Show me something ↗' : 'Enter Scroll'}
        </button>
        {(onEnterRichScrolls || onEnterTestReels) && <details className="preview-menu">
          <summary>Try the preview</summary>
          <div className="preview-menu__choices">
            {onEnterRichScrolls && <button type="button" onClick={() => navigateNow(onEnterRichScrolls)}>Interactive test Scrolls <span aria-hidden="true">↗</span></button>}
            {onEnterTestReels && <button type="button" onClick={() => navigateNow(onEnterTestReels)}>Supplied test Reels <span aria-hidden="true">↗</span></button>}
          </div>
        </details>}
        <p className="cta-helper">
          {stage === 'first' ? 'Your world begins with what catches your curiosity.' : 'A familiar impulse. Somewhere new to go.'}
        </p>
      </div>

      <nav className="universe-dock" aria-label="Main navigation">
        <button type="button" className="dock-button" onClick={() => navigateNow(onEnterScroll)} aria-label="Cable — read a Scroll">
          <span className="dock-icon" aria-hidden="true">〜</span>
          Cable
        </button>
        <button type="button" className="dock-button current" onClick={() => navigateNow(onEnterSystem)} aria-label="Atlas — open your places">
          <span className="dock-icon" aria-hidden="true">◎</span>
          Atlas
        </button>
        <button type="button" className="dock-button" onClick={() => navigateNow(onOpenKeep ?? focusKeep)} aria-label="Keep — your saved Traces">
          <span className="dock-icon" aria-hidden="true">▱</span>
          Keep
        </button>
      </nav>
    </>
  );
}

function skySubtitle(sky: UniverseSky): string {
  const names = sky.stars.map(star => star.name);
  const listed = names.length <= 3 ? joinNames(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const lines = sky.constellations.length;
  const connection = lines === 0 ? '' : lines === 1 ? ' One connection runs between them.' : ` ${lines} connections run between them.`;
  return `${listed}.${connection}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The real `createdAt` timestamp as a short mono sub-label. */
function formatTraceDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function bodyStyle(leftPct: number, topPct: number, sizePx: number): CSSProperties {
  return { left: `${leftPct}%`, top: `${topPct}%`, width: sizePx, height: sizePx };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
