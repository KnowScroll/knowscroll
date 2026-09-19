import { useCallback, useEffect, useRef, useState } from 'react';
import { TRUTH_STATE_MEANING } from '../api/types.ts';
import { useVisibleExposure } from '../hooks/useVisibleExposure.ts';
import type { DiscoveryState, KeepState } from '../state/discovery.ts';
import type { ScrollView } from '../state/readerStore.ts';

export interface ScrollScreenProps {
  state: ScrollView;
  onVisible: (assetId: string) => void;
  onKeep: () => void;
  onNext: () => void;
  onReturn: () => void;
  onRetry: () => void;
  onReadingPosition: (assetId: string, position: number) => void;
}

const SCROLL_STEP = 160;

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
      <p className="eyebrow">{exhausted ? 'Finite library' : 'Discovery'}</p>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="rest-actions">
        <button type="button" onClick={onRetry} disabled={!retryable} aria-label={exhausted ? 'Check the library again' : 'Retry'}>
          {exhausted ? 'Check again' : 'Retry'}
        </button>
        <button type="button" onClick={onReturn} aria-label="Return to Universe">
          Home
        </button>
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
      if (event.key === 'Escape' && sourcesOpen) {
        event.preventDefault();
        setSourcesOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        stageRef.current?.scrollBy({ top: SCROLL_STEP, behavior: 'smooth' });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        stageRef.current?.scrollBy({ top: -SCROLL_STEP, behavior: 'smooth' });
        return;
      }
      if ((event.key === 'n' || event.key === 'N') && !sourcesOpen) {
        event.preventDefault();
        onNext();
        return;
      }
      if ((event.key === 's' || event.key === 'S') && !sourcesOpen) {
        event.preventDefault();
        setSourcesOpen(true);
        return;
      }
      if ((event.key === 'Escape' || event.key === 'Home') && !sourcesOpen) {
        event.preventDefault();
        onReturn();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sourcesOpen, onNext, onReturn]);

  const originLabel = state.origin.type === 'saved-trace' ? 'Saved Trace · revisiting a kept Scroll' : 'Deliberate discovery · a new sourced encounter';
  const truthMeaning = TRUTH_STATE_MEANING[item.truthState] ?? 'No documented meaning is defined for this truth state.';

  return (
    <main className="scroll-screen reading" aria-label="Scroll reader">
      <div className="origin-bar">
        <span className="origin-label">{originLabel}</span>
        <button type="button" className="ghost" onClick={onReturn} aria-label="Return to Universe" aria-keyshortcuts="Escape Home">
          Home
        </button>
      </div>
      <div className={`reading-columns${sourcesOpen ? ' with-rail' : ''}`}>
        <article
          className="reading-stage"
          ref={stageRefCallback}
          tabIndex={-1}
          aria-label={`Reading: ${item.title}`}
        >
          {/* The visible text already states the truth state and its meaning in full;
              an additional aria-label here would be redundant and axe's aria-prohibited-attr
              rule flags aria-label on a plain paragraph (generic role) as unsupported. */}
          <p className="truth-state">
            <strong>{item.truthState.toUpperCase()}</strong> — {truthMeaning}
          </p>
          <h2>{item.title}</h2>
          {item.reason.trim().length > 0 && <p className="reason">{item.reason}</p>}
          <p className="summary">{item.summary}</p>
          <p className="body">{item.body}</p>
          <hr />
          <WhyThisAppeared item={item} origin={originLabel} truthMeaning={truthMeaning} open={whyOpen} onToggle={() => setWhyOpen(v => !v)} />
          <DiscoveryThreshold keep={state.keep} discovery={state.discovery} onNext={onNext} />
        </article>
        {sourcesOpen && <SourceRail item={item} truthMeaning={truthMeaning} onClose={() => setSourcesOpen(false)} />}
      </div>
      <div className="reader-controls">
        {(state.keep.status === 'failed' || state.keep.status === 'conflict') && (
          <p role="alert" className="keep-message">
            {state.keep.message}
          </p>
        )}
        <button
          type="button"
          className="primary"
          onClick={onKeep}
          disabled={state.keep.status === 'saving' || state.keep.status === 'kept' || state.discovery === 'loading'}
          aria-label={state.keep.status === 'kept' ? 'Kept' : state.keep.status === 'saving' ? 'Keeping…' : 'Keep this Scroll'}
        >
          {state.keep.status === 'kept' ? 'Kept' : state.keep.status === 'saving' ? 'Keeping…' : 'Keep'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setSourcesOpen(v => !v)}
          aria-expanded={sourcesOpen}
          aria-label={sourcesOpen ? 'Close sources panel' : 'Open sources panel'}
          aria-keyshortcuts="s"
        >
          Sources
        </button>
      </div>
      <p className="keyboard-help">Keyboard: Up/Down arrows scroll · N next discovery · S sources · Escape or Home returns to Universe.</p>
    </main>
  );
}

function WhyThisAppeared({
  item,
  origin,
  truthMeaning,
  open,
  onToggle,
}: {
  item: { reason: string; truthState: string };
  origin: string;
  truthMeaning: string;
  open: boolean;
  onToggle: () => void;
}) {
  const reasonText = item.reason.trim().length > 0 ? item.reason : 'No explanation recorded.';
  return (
    <section className="why-this-appeared" aria-label="Why this appeared">
      <button type="button" className="ghost" aria-expanded={open} onClick={onToggle}>
        Why this appeared
      </button>
      {open && (
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
      )}
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
      <button type="button" className="primary" onClick={onNext} disabled={disabled} aria-label="Next discovery" aria-keyshortcuts="n">
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
    <aside className="source-rail" aria-label="Source" ref={railRef} tabIndex={-1}>
      <div className="source-rail-header">
        <h3>Source</h3>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close sources panel" aria-keyshortcuts="Escape">
          Close
        </button>
      </div>
      <p className="truth-state small">
        {item.truthState.toUpperCase()} — {truthMeaning}
      </p>
      <p className="source-title">{item.sourceTitle}</p>
      <p className="source-url">{item.sourceUrl}</p>
      <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="primary source-link" aria-label={`Open source: ${item.sourceTitle} (opens in a new tab)`}>
        Open source
      </a>
    </aside>
  );
}
