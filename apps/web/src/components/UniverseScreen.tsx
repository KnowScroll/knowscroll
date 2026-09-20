import { useRef, type CSSProperties } from 'react';
import type { Trace } from '../api/types.ts';
import type { UniverseView } from '../state/readerStore.ts';
import { CosmosBackground } from './CosmosBackground.tsx';

export interface UniverseScreenProps {
  state: UniverseView;
  onEnterScroll: () => void;
  onOpenTrace: (trace: Trace) => void;
  onRetry: () => void;
}

/**
 * Universe level, rebuilt against docs/product/ui-system.md sec.5b/5c
 * (#112): a star ground with labelled bodies, a title HUD, a hint line,
 * a yellow-then-teal call to action with a helper line, a legend, and the
 * three-entry dock -- not a heading, a sentence, a button and scattered dots.
 *
 * Every body is real: a kept Trace by its real title, or (only while the
 * library is genuinely untouched) Living Observatory's own literal
 * first-visit invitation copy, which names no topic and asserts nothing
 * about this reader. See docs/journeys/evidence/web-cosmos/README.md for
 * the deviations this honesty requires from the two references' literal
 * frames (no day-pill age, no status pill, no zoom/geography levels: none
 * of that data exists yet).
 */
export function UniverseScreen({ state, onEnterScroll, onOpenTrace, onRetry }: UniverseScreenProps) {
  return (
    <main className="universe-screen" aria-label="Universe">
      <CosmosBackground />
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
        <LoadedUniverse universe={state.universe.traces} onEnterScroll={onEnterScroll} onOpenTrace={onOpenTrace} />
      )}
    </main>
  );
}

/** Golden-angle spiral placement, the same trick Cosmos's own star ground and canvas
 *  layouts use to scatter bodies without overlap growing with the count. */
function spiralPosition(index: number, total: number): { left: number; top: number } {
  const angle = index * 137.508 * (Math.PI / 180);
  const radius = 12 + (index / Math.max(total, 1)) * 30;
  const left = 50 + Math.cos(angle) * radius * 0.92;
  const top = 46 + Math.sin(angle) * radius * 0.62;
  return { left: Math.min(90, Math.max(10, left)), top: Math.min(78, Math.max(16, top)) };
}

function LoadedUniverse({
  universe,
  onEnterScroll,
  onOpenTrace,
}: {
  universe: Trace[];
  onEnterScroll: () => void;
  onOpenTrace: (trace: Trace) => void;
}) {
  const empty = universe.length === 0;
  const firstBodyRef = useRef<HTMLButtonElement | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  const focusKeep = () => {
    if (firstBodyRef.current) firstBodyRef.current.focus();
    else ctaRef.current?.focus();
  };

  return (
    <>
      <div className="universe-title" aria-hidden="false">
        <p className="eyebrow">KNOWSCROLL</p>
        <h1>Your universe</h1>
        <p className="universe-subtitle">
          {empty
            ? 'Nothing lives here yet. No topics assumed, nothing inferred.'
            : `${universe.length} kept ${universe.length === 1 ? 'Trace' : 'Traces'}.`}
        </p>
      </div>

      {/* Every body here is a real, focusable, labelled control (even the empty-state
          invitation bodies, which trigger the same real discovery action as the CTA) --
          never aria-hidden, which would strand a focusable control from assistive tech. */}
      <div className="universe-bodies">
        {empty ? (
          <>
            <button
              type="button"
              className="body-button seed"
              style={bodyStyle(50, 52, 84)}
              onClick={onEnterScroll}
              aria-label="A first possibility: see what catches your curiosity. Enter Scroll"
              ref={firstBodyRef}
            >
              <span className="body-label">
                <span className="body-name">A first possibility</span>
                <span className="body-sub">See what catches your curiosity</span>
              </span>
            </button>
            <button
              type="button"
              className="body-button dust"
              style={bodyStyle(20, 34, 42)}
              onClick={onEnterScroll}
              aria-label="A different angle. Enter Scroll"
            >
              <span className="body-label">
                <span className="body-name">A different angle</span>
              </span>
            </button>
            <button
              type="button"
              className="body-button dust"
              style={bodyStyle(80, 26, 40)}
              onClick={onEnterScroll}
              aria-label="A little surprise. Enter Scroll"
            >
              <span className="body-label">
                <span className="body-name">A little surprise</span>
              </span>
            </button>
          </>
        ) : (
          <>
            <nav aria-label="Saved Traces" className="universe-bodies-nav">
              <ul>
                {universe.map((trace, i) => {
                  const pos = spiralPosition(i, universe.length);
                  return (
                    <li key={trace.eventId}>
                      <button
                        type="button"
                        className="body-button trace"
                        style={bodyStyle(pos.left, pos.top, 70)}
                        onClick={() => onOpenTrace(trace)}
                        aria-label={`Revisit the saved Trace: ${trace.title || 'Saved Scroll unavailable'}`}
                        ref={i === 0 ? firstBodyRef : undefined}
                      >
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
            {/* The real unread remainder of the finite library. Its exact size is not
                exposed by the bootstrap contract (the feed returns up to three bounded
                candidates, never a total), so it is drawn honestly uncounted rather than
                with an invented number -- see the evidence README's deviation note. */}
            <button
              type="button"
              className="body-button nebula"
              style={bodyStyle(88, 68, 46)}
              onClick={onEnterScroll}
              aria-label="Still unexplored. Enter Scroll"
            >
              <span className="body-label">
                <span className="body-name">Still unexplored</span>
              </span>
            </button>
          </>
        )}
      </div>

      {!empty && (
        <div className="universe-legend" aria-hidden="true">
          <span>
            <i className="legend-dot" /> Your paths
          </span>
          <span>
            <i className="legend-ring" /> Still unexplored
          </span>
        </div>
      )}

      <p className="universe-hint">{empty ? 'Tap a possibility to begin' : 'Tap a Trace to revisit it'}</p>

      <div className="universe-cta-block">
        <button
          type="button"
          className={empty ? 'pill yellow universe-cta' : 'pill teal universe-cta'}
          onClick={onEnterScroll}
          aria-label="Enter Scroll"
          ref={empty ? undefined : ctaRef}
        >
          {empty ? 'Show me something ↗' : 'Enter Scroll'}
        </button>
        <p className="cta-helper">
          {empty ? 'Your world begins with what catches your curiosity.' : 'A familiar impulse. Somewhere new to go.'}
        </p>
      </div>

      <nav className="universe-dock" aria-label="Main navigation">
        <button type="button" className="dock-button" onClick={onEnterScroll} aria-label="Cable — read a Scroll">
          <span className="dock-icon" aria-hidden="true">
            〜
          </span>
          Cable
        </button>
        <button type="button" className="dock-button current" aria-current="page" onClick={() => {}} aria-label="Atlas — your universe">
          <span className="dock-icon" aria-hidden="true">
            ◎
          </span>
          Atlas
        </button>
        <button type="button" className="dock-button" onClick={focusKeep} aria-label="Keep — your saved Traces">
          <span className="dock-icon" aria-hidden="true">
            ▱
          </span>
          Keep
        </button>
      </nav>
    </>
  );
}

/** The real `createdAt` timestamp, rendered as Cosmos's own mono sub-label style
 *  ("3 STOPS") rather than a raw ISO string -- same data, legible presentation. */
function formatTraceDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function bodyStyle(leftPct: number, topPct: number, sizePx: number): CSSProperties {
  return { left: `${leftPct}%`, top: `${topPct}%`, width: sizePx, height: sizePx };
}
