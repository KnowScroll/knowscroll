import { useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Trace, Universe } from '../api/types.ts';
import type { UniverseView } from '../state/readerStore.ts';
import type { ReaderStorage } from '../state/storage.ts';
import { CosmosBackground } from './CosmosBackground.tsx';

export interface UniverseScreenProps {
  state: UniverseView;
  storage: ReaderStorage;
  onEnterScroll: () => void;
  onOpenTrace: (trace: Trace) => void;
  onEnterSystem: () => void;
  onOpenPrivacy: () => void;
  onRetry: () => void;
}

/**
 * Universe level, rebuilt against docs/product/ui-system.md sec.5b/5c
 * (#112): a star ground with labelled bodies, a title HUD, a hint line,
 * a yellow-then-teal call to action with a helper line, a legend, map
 * tools, and the three-entry dock -- not a heading, a sentence, a button
 * and scattered dots.
 *
 * Every body is real: a kept Trace by its real title, or (only while the
 * library is genuinely untouched) Living Observatory's own literal
 * first-visit invitation copy, which names no topic and asserts nothing
 * about this reader. See docs/journeys/evidence/web-cosmos/README.md for
 * the deviations this honesty requires from the two references' literal
 * frames (no system/interior/planet levels: no semantic geography exists
 * yet -- sec.5b's own table).
 */
export function UniverseScreen({ state, storage, onEnterScroll, onOpenTrace, onEnterSystem, onOpenPrivacy, onRetry }: UniverseScreenProps) {
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
        <LoadedUniverse
          universe={state.universe}
          storage={storage}
          onEnterScroll={onEnterScroll}
          onOpenTrace={onOpenTrace}
          onEnterSystem={onEnterSystem}
          onOpenPrivacy={onOpenPrivacy}
        />
      )}
    </main>
  );
}

/**
 * Three real stages, chosen only from what this reader has actually kept --
 * never from a date (ui-system.md sec.5c: "the stage is chosen from what this
 * reader has actually done, never from a date"). `grown` starts at a round,
 * unfitted threshold (double digits) rather than any number tuned to a
 * particular run.
 */
type Stage = 'first' | 'few' | 'grown';
const GROWN_THRESHOLD = 10;

function stageFor(keptCount: number): Stage {
  if (keptCount === 0) return 'first';
  if (keptCount < GROWN_THRESHOLD) return 'few';
  return 'grown';
}

/** Verbatim from living-observatory.html's own `renderMap()` (sec.5c). */
const STAGE_HEADING: Record<Stage, string> = {
  first: 'Somewhere new starts here.',
  few: 'Your first little world.',
  grown: 'A world taking shape.',
};
const STAGE_SUBTITLE_FIRST = 'No topics to pick. Just something interesting.';
const STAGE_SUBTITLE_FEW = 'A few encounters are beginning to belong together.';

/* ---------- Body layout: a deterministic grid, never a continuous spiral ----------
 * The reference's own spiral placement let two bodies land close enough in
 * angle and radius that their labels collided at 13 kept Traces. Every
 * body's row/column -- and the character budget its label is allowed -- is
 * derived purely from its position among the real bodies being drawn, so two
 * labels can never physically overlap at any count this finite library can
 * produce (sec.5b/7). Rows are spaced far enough apart that two bodies in
 * different rows can never collide regardless of column; within a row, each
 * slot's label is capped to a character width that provably fits in that
 * slot's own share of the canvas at the smaller of the two fidelity-tested
 * widths (sec.7: 1024x768).
 */
const CANVAS_LEFT = 12;
const CANVAS_RIGHT = 88;
const CANVAS_TOP = 8; // % of .universe-bodies, which is already inset clear of the title HUD
const CANVAS_BOTTOM = 78; // leaves the last row's two-line label inside the inset canvas
const MIN_ROW_GAP_PCT = 20; // vertical % between row centres; safe for a ~90px body + its label at 1024x768
const MIN_SUPPORTED_WIDTH_PX = 1024; // the smaller fidelity-tested width (sec.7)
const AVG_CHAR_PX = 8; // a deliberately wide estimate for 13px/700-weight text -- safer, not tighter
const LABEL_GUTTER_CH = 3;
const MIN_LABEL_CH = 8;
const DEFAULT_LABEL_CH = 26; // styles.css's own default cap, used whenever a slot has room to spare
const COMFORTABLE_LABEL_CH = 16; // below this, a second row is worth the extra vertical space it costs

interface BodySlot {
  left: number;
  top: number;
  labelCh: number;
}

function labelCharsForRow(count: number): number {
  const usableWidth = CANVAS_RIGHT - CANVAS_LEFT;
  const slotPct = count <= 1 ? usableWidth : usableWidth / count;
  const slotPx = (slotPct / 100) * MIN_SUPPORTED_WIDTH_PX;
  return Math.floor(slotPx / AVG_CHAR_PX) - LABEL_GUTTER_CH;
}

/**
 * Grows the row count only as far as it is actually needed: a handful of bodies stays on one
 * centred row (the shape every low count already had, and the one that stays clear of the title
 * HUD at a short window), and a second or third row is added only once a single row would pack
 * labels tighter than `COMFORTABLE_LABEL_CH` -- never merely because the count crossed some fixed
 * threshold. `maxRows` still bounds how many rows the vertical canvas can safely fit at all.
 */
function planRowCounts(total: number): number[] {
  if (total <= 0) return [];
  const maxRows = Math.max(1, Math.floor((CANVAS_BOTTOM - CANVAS_TOP) / MIN_ROW_GAP_PCT) + 1);
  let rows = 1;
  while (rows < maxRows && labelCharsForRow(Math.ceil(total / rows)) < COMFORTABLE_LABEL_CH) {
    rows++;
  }
  const counts: number[] = [];
  let remaining = total;
  for (let r = 0; r < rows; r++) {
    const rowsLeft = rows - r;
    const count = Math.ceil(remaining / rowsLeft);
    counts.push(count);
    remaining -= count;
  }
  return counts;
}

function layoutBodies(total: number): BodySlot[] {
  const rowCounts = planRowCounts(total);
  const rows = rowCounts.length;
  const usableWidth = CANVAS_RIGHT - CANVAS_LEFT;
  const slots: BodySlot[] = [];
  rowCounts.forEach((count, r) => {
    const top = rows === 1 ? (CANVAS_TOP + CANVAS_BOTTOM) / 2 : CANVAS_TOP + (r * (CANVAS_BOTTOM - CANVAS_TOP)) / (rows - 1);
    const labelCh = Math.max(MIN_LABEL_CH, Math.min(DEFAULT_LABEL_CH, labelCharsForRow(count)));
    for (let c = 0; c < count; c++) {
      const left = count === 1 ? (CANVAS_LEFT + CANVAS_RIGHT) / 2 : CANVAS_LEFT + (c * usableWidth) / (count - 1);
      slots.push({ left, top, labelCh });
    }
  });
  return slots;
}

/* ---------- Body surface: real, deterministic variety, never random ----------
 * Size and surface detail are both derived from the Trace's own real
 * `createdAt` age; colour cycles across Cosmos's own approved accent
 * palette by the body's real position in the (oldest-first) kept order.
 * None of it implies a meaning nothing records -- it is the same "how long
 * has this been kept" fact already shown as text in `body-sub`, just also
 * carried into the body's appearance instead of drawing one identical flat
 * sphere for every Trace (the defect this replaces).
 */
const BODY_PALETTE = [
  { core: '#fff6cf', mid: '#ffd058', edge: '#a9791f', glow: 'rgba(255,208,88,.45)' }, // yellow
  { core: '#e8fffb', mid: '#33c4b4', edge: '#0f5f57', glow: 'rgba(51,196,180,.45)' }, // teal
  { core: '#eafff3', mid: '#64d47d', edge: '#1f7a3c', glow: 'rgba(100,212,125,.45)' }, // green
  { core: '#fff0f6', mid: '#ed87b4', edge: '#8c3f63', glow: 'rgba(237,135,180,.45)' }, // pink
] as const;

function paletteFor(index: number) {
  // Non-null: the modulo always lands inside BODY_PALETTE's fixed length.
  return BODY_PALETTE[index % BODY_PALETTE.length]!;
}

function ageDays(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / 86_400_000);
}

function sizeForAge(days: number): number {
  const clamped = Math.min(days, 30);
  return 56 + (clamped / 30) * 34; // 56..90
}

function craterCountForAge(days: number): 0 | 1 | 2 {
  if (days < 2) return 0;
  if (days < 14) return 1;
  return 2;
}

const CRATER_LAYOUTS: Record<number, Array<{ cx: number; cy: number; r: number }>> = {
  0: [],
  1: [{ cx: 62, cy: 66, r: 8 }],
  2: [
    { cx: 62, cy: 66, r: 8 },
    { cx: 34, cy: 40, r: 5 },
  ],
};

function BodySurface({ sizePx, paletteIndex, craterCount, idSeed }: { sizePx: number; paletteIndex: number; craterCount: number; idSeed: string }) {
  const palette = paletteFor(paletteIndex);
  const gradientId = `body-grad-${idSeed}`;
  return (
    <svg viewBox="0 0 100 100" width={sizePx} height={sizePx} aria-hidden="true" focusable="false" className="body-surface">
      <defs>
        <radialGradient id={gradientId} cx="34%" cy="30%" r="75%">
          <stop offset="0%" stopColor={palette.core} />
          <stop offset="55%" stopColor={palette.mid} />
          <stop offset="100%" stopColor={palette.edge} />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${gradientId})`} />
      {/* A soft terminator crescent, giving the sphere volume instead of a flat disc. */}
      <path d="M 66 6 A 48 48 0 0 1 66 94 A 58 58 0 0 0 66 6 Z" fill={palette.edge} opacity="0.32" />
      {(CRATER_LAYOUTS[craterCount] ?? []).map((c, i) => (
        <ellipse key={i} cx={c.cx} cy={c.cy} rx={c.r} ry={c.r * 0.7} fill={palette.edge} opacity="0.28" />
      ))}
    </svg>
  );
}

function labelWidthStyle(ch: number): CSSProperties {
  return { '--label-max': `${ch}ch` } as CSSProperties;
}

interface LoadedUniverseProps {
  universe: Universe;
  storage: ReaderStorage;
  onEnterScroll: () => void;
  onOpenTrace: (trace: Trace) => void;
  onEnterSystem: () => void;
  onOpenPrivacy: () => void;
}

function LoadedUniverse({ universe, storage, onEnterScroll, onOpenTrace, onEnterSystem, onOpenPrivacy }: LoadedUniverseProps) {
  const traces = universe.traces;
  const empty = traces.length === 0;
  const stage = stageFor(traces.length);
  const firstBodyRef = useRef<HTMLButtonElement | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  const [zoom, setZoom] = useState(1);

  const focusKeep = () => {
    if (firstBodyRef.current) firstBodyRef.current.focus();
    else ctaRef.current?.focus();
  };

  // The real why-this-appeared reason for the most recently kept Trace (never a fabricated
  // growth claim -- sec.5c). Only trusted within the same universe/privacy scope as what is
  // actually loaded right now, exactly like every other scoped read in this app.
  const growthNote = useMemo(() => {
    if (stage !== 'few') return null;
    const stored = storage.readLastKept();
    if (!stored || stored.universeId !== universe.universeId || stored.privacyEpoch !== universe.privacyEpoch) return null;
    const reason = stored.reason.trim();
    return reason.length > 0 ? reason : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, storage, universe.universeId, universe.privacyEpoch, traces.length]);

  // Traces plus one trailing slot for the "still unexplored" body -- laid out together so the
  // unexplored body can never collide with the last row of real Traces either.
  const slots = useMemo(() => (empty ? [] : layoutBodies(traces.length + 1)), [empty, traces.length]);

  return (
    <>
      <div className="universe-title" aria-hidden="false">
        <p className="eyebrow">KNOWSCROLL</p>
        <h1>{STAGE_HEADING[stage]}</h1>
        <p className="universe-subtitle">
          {stage === 'first' ? STAGE_SUBTITLE_FIRST : stage === 'few' ? STAGE_SUBTITLE_FEW : `${traces.length} kept ${traces.length === 1 ? 'Trace' : 'Traces'}.`}
        </p>
        {growthNote && <p className="growth-caption">{growthNote}</p>}
      </div>

      {/* #119: reachable regardless of whether anything has been kept yet -- pausing, exporting
          and resetting are all real capabilities of a universe that has recorded nothing just as
          much as one that has recorded a great deal, so this is never conditioned on `empty` the
          way the legend/map-tools below are. Neither Cosmos nor Living Observatory draws a
          privacy control at all; this sits in Cosmos's own reserved-but-otherwise-unused top-right
          status-pill slot (`.universe-title`'s own `right:150px` already clears this exact space)
          rather than inventing a new frame position. */}
      <button type="button" className="pill cream privacy-entry" onClick={onOpenPrivacy} aria-label="Open privacy controls">
        Privacy
      </button>

      {/* Every body here is a real, focusable, labelled control (even the empty-state
          invitation bodies, which trigger the same real discovery action as the CTA) --
          never aria-hidden, which would strand a focusable control from assistive tech. */}
      <div className="universe-bodies" style={zoom !== 1 ? { transform: `scale(${zoom})` } : undefined}>
        {empty ? (
          <>
            <button
              type="button"
              className="body-button seed"
              style={bodyStyle(50, 52, 84)}
              onClick={onEnterScroll}
              aria-label="A first possibility: see what catches your curiosity"
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
              aria-label="A different angle"
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
              aria-label="A little surprise"
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
                {traces.map((trace, i) => {
                  // Defensive fallback only: layoutBodies(traces.length + 1) always produces at
                  // least one slot per Trace, so this never actually falls through in practice.
                  const slot = slots[i] ?? { left: 50, top: 50, labelCh: DEFAULT_LABEL_CH };
                  const days = ageDays(trace.createdAt);
                  const sizePx = sizeForAge(days);
                  const palette = paletteFor(i);
                  return (
                    <li key={trace.eventId}>
                      <button
                        type="button"
                        className="body-button trace"
                        style={{ ...bodyStyle(slot.left, slot.top, sizePx), boxShadow: `0 0 26px ${palette.glow}, inset 0 0 0 1px rgba(255,255,255,.18)` }}
                        onClick={() => onOpenTrace(trace)}
                        aria-label={`Revisit the saved Trace: ${trace.title || 'Saved Scroll unavailable'}`}
                        ref={i === 0 ? firstBodyRef : undefined}
                      >
                        <BodySurface sizePx={sizePx} paletteIndex={i} craterCount={craterCountForAge(days)} idSeed={trace.eventId} />
                        <span className="body-label" style={labelWidthStyle(slot.labelCh)}>
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
                with an invented number -- see the evidence README's deviation note. Laid
                out as the trailing slot of the same grid as the real Traces, so it can
                never collide with them either. */}
            {(() => {
              const nebulaSlot = slots[traces.length] ?? { left: 88, top: 68, labelCh: DEFAULT_LABEL_CH };
              return (
                <button type="button" className="body-button nebula" style={bodyStyle(nebulaSlot.left, nebulaSlot.top, 46)} onClick={onEnterScroll} aria-label="Still unexplored">
                  <span className="body-label" style={labelWidthStyle(nebulaSlot.labelCh)}>
                    <span className="body-name">Still unexplored</span>
                  </span>
                </button>
              );
            })()}
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

      {!empty && (
        <div className="map-tools" aria-label="Map controls">
          <button type="button" className="zoom-button" onClick={() => setZoom(z => Math.max(0.75, Math.round((z - 0.15) * 100) / 100))} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="zoom-button" onClick={() => setZoom(z => Math.min(1.35, Math.round((z + 0.15) * 100) / 100))} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="zoom-button recenter" onClick={() => setZoom(1)} aria-label="Recenter the universe">
            ⌖
          </button>
          {/* Living Observatory's own scale label (its `#scaleLabel`) names which of four
              navigable depths ("PLANET"/"SYSTEM"/"GALAXY"/"UNIVERSE VIEW") the reader is at.
              When this was written the build had exactly one real level, so the label said
              "UNIVERSE VIEW" and said nothing else: naming a depth the build could not reach
              would have claimed semantic geography that did not exist.

              #116 built that depth for real. A system is now derived from recorded evidence
              alone (ADR-0028) and served by `GET /v1/worlds`, so the second level named in
              sec.5b exists and is reachable -- and the label becomes what the reference always
              made it, a control that goes there. It still claims nothing: the system it opens
              names only the worlds this reader's own reading has actually reached, and says so
              plainly when that set is empty. */}
          <button type="button" className="map-scale-label" onClick={onEnterSystem} aria-label="Open the system view">
            SYSTEM VIEW
          </button>
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
