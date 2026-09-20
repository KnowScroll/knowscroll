import { useCallback, useEffect, useRef, useState } from 'react';
import { TRUTH_STATE_MEANING } from '../api/types.ts';
import { useVisibleExposure } from '../hooks/useVisibleExposure.ts';
import type { DiscoveryState, KeepState } from '../state/discovery.ts';
import type { ScrollView } from '../state/readerStore.ts';

const SCROLL_STEP = 160;

/**
 * Scrolls the reading column by one step and reports whether it actually
 * moved. `false` means the reader is already at the end (or there is nothing
 * to scroll), which is what turns the down arrow into "next discovery".
 * Smooth scrolling is motion, so it is suspended under `prefers-reduced-motion`
 * exactly like every transition in styles.css -- the position still changes,
 * instantly.
 */
function scrollReadingColumn(node: HTMLElement | null, delta: number): boolean {
  if (!node) return false;
  const atEnd = delta > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  const atStart = delta < 0 && node.scrollTop <= 0;
  if (atEnd || atStart) return false;
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  node.scrollBy({ top: delta, behavior: reduced ? 'auto' : 'smooth' });
  return true;
}

export interface ScrollScreenProps {
  state: ScrollView;
  onVisible: (assetId: string) => void;
  onKeep: () => void;
  onNext: () => void;
  onReturn: () => void;
  onRetry: () => void;
  onReadingPosition: (assetId: string, position: number) => void;
}

/** Only these seven truth states have a documented presentation (definition.md sec.12); anything
 * else falls back to the neutral base `.truth-pill` tint rather than guessing a colour. */
const KNOWN_TRUTH_STATES = new Set(['documented', 'synthesis', 'interpretation', 'disputed', 'modelled', 'counterfactual', 'fictional']);

function truthPillClassName(truthState: string): string {
  const slug = truthState.toLowerCase();
  return KNOWN_TRUTH_STATES.has(slug) ? `truth-pill state-${slug}` : 'truth-pill';
}

export function ScrollScreen({ state, onVisible, onKeep, onNext, onReturn, onRetry, onReadingPosition }: ScrollScreenProps) {
  if (state.status === 'reading') {
    return (
      <ReadingStage
        key={state.item.assetId}
        state={state}
        onVisible={onVisible}
        onKeep={onKeep}
        onNext={onNext}
        onReturn={onReturn}
        onReadingPosition={onReadingPosition}
      />
    );
  }
  if (state.status === 'unavailable') {
    return <RestScreen title="This Scroll is unavailable" message={state.message} exhausted={false} onReturn={onReturn} onRetry={onRetry} retryable={state.retryable} />;
  }
  if (state.status === 'exhausted') {
    return (
      <RestScreen
        title="You've reached the end of the current library"
        message="There is no unread sourced Scroll left right now. Check back later, or revisit a saved Trace."
        exhausted
        onReturn={onReturn}
        onRetry={onRetry}
        retryable
      />
    );
  }
  return (
    <main className="scroll-screen" aria-label="Scroll" aria-busy="true">
      <p role="status" aria-live="polite">
        Loading a sourced encounter…
      </p>
    </main>
  );
}

function RestScreen({
  title,
  message,
  exhausted,
  onReturn,
  onRetry,
  retryable,
}: {
  title: string;
  message: string;
  exhausted: boolean;
  onReturn: () => void;
  onRetry: () => void;
  retryable: boolean;
}) {
  return (
    <main className="scroll-screen rest-screen" aria-label="Scroll">
      <div className="rest-card">
        <p className="eyebrow">{exhausted ? 'Finite library' : 'Discovery'}</p>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="rest-actions">
          <button type="button" className="pill teal" onClick={onRetry} disabled={!retryable} aria-label={exhausted ? 'Check the library again' : 'Retry'}>
            {exhausted ? 'Check again' : 'Retry'}
          </button>
          <button type="button" className="pill cream" onClick={onReturn} aria-label="Return to Universe">
            ‹ Universe
          </button>
        </div>
      </div>
    </main>
  );
}

function ReadingStage({
  state,
  onVisible,
  onKeep,
  onNext,
  onReturn,
  onReadingPosition,
}: {
  state: Extract<ScrollView, { status: 'reading' }>;
  onVisible: (assetId: string) => void;
  onKeep: () => void;
  onNext: () => void;
  onReturn: () => void;
  onReadingPosition: (assetId: string, position: number) => void;
}) {
  const { item } = state;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const stageRef = useRef<HTMLElement | null>(null);
  const [stageNode, setStageNode] = useState<HTMLElement | null>(null);
  const stageRefCallback = useCallback((node: HTMLElement | null) => {
    stageRef.current = node;
    setStageNode(node);
  }, []);

  useVisibleExposure(stageNode, item.assetId, onVisible);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    node.scrollTop = state.readingPosition;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onReadingPosition(item.assetId, node.scrollTop), 200);
    };
    node.addEventListener('scroll', onScroll);
    return () => {
      if (timeout) clearTimeout(timeout);
      onReadingPosition(item.assetId, node.scrollTop);
      node.removeEventListener('scroll', onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.assetId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      // Pointer and keyboard are equal (definition.md sec.9.5): the down
      // arrow is the same action as the "Next" pill -- but only once there is
      // no more of this Scroll to read. While text remains below the fold the
      // down arrow reads on, because a key that jumps to a different Scroll
      // mid-paragraph both loses the reader's place and spends a deliberate
      // discovery by accident. ArrowRight is deliberately never bound -- no
      // continuation contract exists, and an empty gesture is worse than none
      // (ui-system.md sec.4).
      if (event.key === 'ArrowDown' && !sourcesOpen && !whyOpen) {
        event.preventDefault();
        if (scrollReadingColumn(stageRef.current, SCROLL_STEP)) return;
        onNext();
        return;
      }
      if (event.key === 'ArrowUp' && !sourcesOpen && !whyOpen) {
        event.preventDefault();
        scrollReadingColumn(stageRef.current, -SCROLL_STEP);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (whyOpen) {
          setWhyOpen(false);
          return;
        }
        if (sourcesOpen) {
          setSourcesOpen(false);
          return;
        }
        onReturn();
        return;
      }
      if (event.key === 'Home' && !sourcesOpen && !whyOpen) {
        event.preventDefault();
        onReturn();
        return;
      }
      if ((event.key === 'n' || event.key === 'N') && !sourcesOpen && !whyOpen) {
        event.preventDefault();
        onNext();
        return;
      }
      if ((event.key === 's' || event.key === 'S') && !sourcesOpen) {
        event.preventDefault();
        setWhyOpen(false);
        setSourcesOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sourcesOpen, whyOpen, onNext, onReturn]);

  const originLabel = state.origin.type === 'saved-trace' ? 'Saved Trace · revisiting a kept Scroll' : 'Deliberate discovery · a new sourced encounter';
  const truthMeaning = TRUTH_STATE_MEANING[item.truthState] ?? 'No documented meaning is defined for this truth state.';

  return (
    <main className="scroll-screen reading" aria-label="Scroll reader">
      <header className="head-band">
        <button type="button" className="pill cream" onClick={onReturn} aria-label="Return to Universe" aria-keyshortcuts="Escape">
          ‹ Universe
        </button>
        <span className="head-band-origin">{originLabel}</span>
        <span className="head-band-kind">Scroll</span>
      </header>
      <div className="scroll-layout">
        <aside className="context-rail" aria-label="Context">
          <button
            type="button"
            className="pill cream"
            onClick={() => {
              setWhyOpen(false);
              setSourcesOpen(v => !v);
            }}
            aria-expanded={sourcesOpen}
            aria-label={sourcesOpen ? 'Close sources panel' : 'Open sources panel'}
            aria-keyshortcuts="s"
          >
            Sources
          </button>
          <button
            type="button"
            className="pill cream"
            aria-expanded={whyOpen}
            onClick={() => {
              setSourcesOpen(false);
              setWhyOpen(v => !v);
            }}
          >
            Why this appeared
          </button>
          <WhyThisAppeared item={item} origin={originLabel} truthMeaning={truthMeaning} open={whyOpen} />
        </aside>
        <article
          className="reading-column"
          ref={stageRefCallback}
          tabIndex={-1}
          aria-label={`Reading: ${item.title}`}
        >
          {/* The truth pill sits directly above the claim it qualifies, never
              buried at the end (definition.md law 13, sec.12). The visible
              text already states the truth state and its meaning in full; an
              additional aria-label here would be redundant and axe's
              aria-prohibited-attr rule flags aria-label on a generic-role
              element as unsupported. */}
          <div className="truth-line">
            <span className={truthPillClassName(item.truthState)}>{item.truthState.toUpperCase()}</span>
            <span className="truth-meaning">{truthMeaning}</span>
          </div>
          <h2>{item.title}</h2>
          {item.reason.trim().length > 0 && <p className="reason">{item.reason}</p>}
          <p className="summary">{item.summary}</p>
          <p className="body">{item.body}</p>
          <div className="continue">
            {(state.keep.status === 'failed' || state.keep.status === 'conflict') && (
              <p role="alert" className="keep-message">
                {state.keep.message}
              </p>
            )}
            <button
              type="button"
              className="pill yellow"
              onClick={onKeep}
              disabled={state.keep.status === 'saving' || state.keep.status === 'kept' || state.discovery === 'loading'}
              aria-label={state.keep.status === 'kept' ? 'Kept' : state.keep.status === 'saving' ? 'Keeping…' : 'Keep this Scroll'}
            >
              {state.keep.status === 'kept' ? 'Kept' : state.keep.status === 'saving' ? 'Keeping…' : 'Keep'}
            </button>
            <DiscoveryThreshold keep={state.keep} discovery={state.discovery} onNext={onNext} />
          </div>
        </article>
        {sourcesOpen && <SourceRail item={item} truthMeaning={truthMeaning} onClose={() => setSourcesOpen(false)} />}
      </div>
      <p className="keyboard-help">Keyboard: ↓ reads on, then takes the next discovery · N next · S sources · Escape or Home returns to Universe.</p>
    </main>
  );
}

function WhyThisAppeared({
  item,
  origin,
  truthMeaning,
  open,
}: {
  item: { reason: string; truthState: string };
  origin: string;
  truthMeaning: string;
  open: boolean;
}) {
  if (!open) return null;
  const reasonText = item.reason.trim().length > 0 ? item.reason : 'No explanation recorded.';
  return (
    <section className="why-this-appeared" aria-label="Why this appeared">
      <dl>
        <dt>Reason</dt>
        <dd>{reasonText}</dd>
        <dt>Truth state</dt>
        <dd>
          {item.truthState.toUpperCase()} — {truthMeaning}
        </dd>
        <dt>Origin</dt>
        <dd>{origin}</dd>
      </dl>
    </section>
  );
}

function DiscoveryThreshold({ keep, discovery, onNext }: { keep: KeepState; discovery: DiscoveryState; onNext: () => void }) {
  const disabled = discovery === 'loading' || keep.status === 'saving' || keep.status === 'failed' || keep.status === 'conflict';
  return (
    <section className="discovery-threshold" aria-label="Next discovery">
      <h3>{discovery === 'exhausted' ? "You've reached the end of the current library" : 'Ready for another sourced encounter?'}</h3>
      {discovery === 'failed' && <p role="alert">The next Scroll could not be loaded. Try again.</p>}
      {discovery === 'loading' && (
        <p role="status" aria-live="polite">
          Finding the next sourced encounter…
        </p>
      )}
      <button type="button" className="pill teal" onClick={onNext} disabled={disabled} aria-label="Next discovery" aria-keyshortcuts="n ArrowDown">
        {discovery === 'failed' ? 'Retry next' : discovery === 'exhausted' ? 'Check again' : 'Next'}
      </button>
    </section>
  );
}

function SourceRail({ item, truthMeaning, onClose }: { item: { sourceTitle: string; sourceUrl: string; title: string; truthState: string }; truthMeaning: string; onClose: () => void }) {
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    railRef.current?.focus();
  }, []);
  return (
    <aside className="source-sheet" aria-label="Source" ref={railRef} tabIndex={-1}>
      <div className="source-sheet-header">
        <h3>Source</h3>
        {/* Distinct accessible name from the context-rail toggle (which already
            reads "Close sources panel" once open): two controls performing
            the same action must not share one name. */}
        <button type="button" className="pill ghost" onClick={onClose} aria-label="Close the source panel" aria-keyshortcuts="Escape">
          Close
        </button>
      </div>
      <div className="truth-line on-cream">
        <span className={truthPillClassName(item.truthState)}>{item.truthState.toUpperCase()}</span>
        <span className="truth-meaning">{truthMeaning}</span>
      </div>
      <p className="source-title">{item.sourceTitle}</p>
      <p className="source-url">{item.sourceUrl}</p>
      <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="pill teal source-link" aria-label={`Open source: ${item.sourceTitle} (opens in a new tab)`}>
        Open source
      </a>
    </aside>
  );
}
