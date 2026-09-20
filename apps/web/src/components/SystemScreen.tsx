import { useEffect } from 'react';
import type { WorldSummary, WorldSystemResponse } from '../api/types.ts';
import type { SystemView } from '../state/readerStore.ts';

export interface SystemScreenProps {
  state: SystemView;
  onReturn: () => void;
  onRetry: () => void;
}

/**
 * The system level (#116): one body per real `world` the API actually returned, drawn the way the
 * Cosmos reference draws a system -- a centre, an orbit, bodies with a name and a mono status label
 * -- but nothing here is invented. Every name, count and link comes straight from `GET /v1/worlds`
 * (ADR-0028/#113); a body's position on the ring is decorative (no ranking signal exists to place
 * it honestly), but its identity and its numbers are never decorated.
 */
export function SystemScreen({ state, onReturn, onRetry }: SystemScreenProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Home') {
        event.preventDefault();
        onReturn();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onReturn]);

  return (
    <main className="system-screen" aria-label="System">
      <header className="head-band">
        <button type="button" className="pill cream" onClick={onReturn} aria-label="Return to Universe" aria-keyshortcuts="Escape">
          ‹ Universe
        </button>
        <span className="head-band-origin">Derived from recorded sources, never inferred</span>
        <span className="head-band-kind">System</span>
      </header>
      <div className="system-stage">
        {(state.status === 'idle' || state.status === 'loading') && (
          <p role="status" aria-live="polite">
            Deriving your system…
          </p>
        )}
        {state.status === 'unavailable' && (
          <div className="unavailable-block" role="alert">
            <h2>The system is unavailable</h2>
            <p className="detail">{state.message}</p>
            <button type="button" className="pill orange" onClick={onRetry} aria-label="Retry loading the system">
              Retry
            </button>
          </div>
        )}
        {state.status === 'loaded' && <SystemBody response={state.response} />}
      </div>
      <p className="keyboard-help">Keyboard: Escape or Home returns to Universe.</p>
    </main>
  );
}

function SystemBody({ response }: { response: WorldSystemResponse }) {
  const { system } = response;
  if (!system) {
    return (
      <div className="system-empty">
        <p className="eyebrow">No system yet</p>
        <h2>Nothing has been encountered yet</h2>
        <p>
          There is no system yet because nothing has been encountered. A system only ever names the worlds this
          universe&apos;s own reading has actually reached &mdash; nothing is arranged ahead of that.
        </p>
      </div>
    );
  }
  const worlds = system.worlds;
  return (
    <>
      <div className="system-head">
        <p className="eyebrow">System</p>
        <h2>Your system</h2>
        <p className="system-subtitle">{systemSubtitle(worlds)}</p>
      </div>
      <div className="system-orbit" role="list" aria-label="Worlds in your system">
        {/* viewBox matches .system-orbit's own 16:10 aspect ratio exactly (unlike a square viewBox
            forced to fill it), so the sun stays a true circle instead of a squashed oval. */}
        <svg viewBox="0 0 400 250" className="system-orbit-svg" aria-hidden="true">
          <ellipse className="system-ring" cx="200" cy="125" rx="160" ry="60" />
          <circle className="system-sun" cx="200" cy="125" r="22" />
        </svg>
        {worlds.map((world, index) => (
          <WorldBody key={world.worldId} world={world} index={index} total={worlds.length} />
        ))}
      </div>
    </>
  );
}

function systemSubtitle(worlds: WorldSummary[]): string {
  const totalScrolls = worlds.reduce((sum, world) => sum + world.scrollCount, 0);
  const totalSeen = worlds.reduce((sum, world) => sum + world.seenCount, 0);
  const worldWord = worlds.length === 1 ? 'WORLD' : 'WORLDS';
  const scrollWord = totalScrolls === 1 ? 'SCROLL' : 'SCROLLS';
  return `${worlds.length} ${worldWord} · ${totalScrolls} ${scrollWord} RECORDED · ${totalSeen} SEEN`;
}

function WorldBody({ world, index, total }: { world: WorldSummary; index: number; total: number }) {
  // Decorative placement only (ui-system.md sec.6: a background/position detail carries no
  // semantic identity unless it is one of the two guarded facts below). No attention/ranking
  // signal exists to place a world honestly closer or farther, so every body sits on the one
  // real orbit, evenly spaced by the order the API returned.
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  const left = 50 + Math.cos(angle) * 40;
  const top = 50 + Math.sin(angle) * 24;
  // The one distinct, database-verified treatment this view draws: has this reader's own exposure
  // history reached every recorded Scroll behind this world, or is there real, counted more to it.
  // `GET /v1/worlds` only ever returns a world this universe has encountered at least once
  // (ADR-0028's `seen_count >= 1` guard), so "nothing seen yet" is never a state a returned world
  // can be in -- the honest distinction available from these two real counts is fully vs partially
  // reached, not encountered vs not.
  const fullyExplored = world.scrollCount > 0 && world.seenCount >= world.scrollCount;
  const scrollWord = world.scrollCount === 1 ? 'SCROLL' : 'SCROLLS';
  return (
    <div
      className={`world-body ${fullyExplored ? 'world-explored' : 'world-partial'}`}
      style={{ left: `${left}%`, top: `${top}%` }}
      role="listitem"
    >
      <span className="world-orb" aria-hidden="true" />
      <span className="world-name">{world.sourceTitle}</span>
      <span className="world-status">{`${world.scrollCount} ${scrollWord} · ${world.seenCount} SEEN`}</span>
      <span className="world-tag">{fullyExplored ? 'FULLY EXPLORED' : 'MORE TO EXPLORE'}</span>
      <a
        className="pill teal world-source-link"
        href={world.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open source: ${world.sourceTitle} (opens in a new tab)`}
      >
        Open source
      </a>
    </div>
  );
}
