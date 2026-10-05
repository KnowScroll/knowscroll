import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TRUTH_STATE_MEANING, type EncounterFeedbackKind } from '../api/types.ts';
import { useVisibleExposure } from '../hooks/useVisibleExposure.ts';
import type { DiscoveryState, KeepState } from '../state/discovery.ts';
import type { ScrollView, WhyView } from '../state/readerStore.ts';
import { WhatLedHere } from './WhatLedHere.tsx';
import { NativeScroll } from './NativeScroll.tsx';
import { RepresentationSwitch } from './RepresentationSwitch.tsx';

const SCROLL_STEP = 160;

/**
 * Scrolls the reading column by one step and reports whether it actually
 * moved. `false` means the reader is already at the end (or there is nothing
 * to scroll), which is what turns the down arrow into "next discovery".
 * Smooth scrolling is motion, so it is suspended under `prefers-reduced-motion`
 * exactly like every transition in styles.css -- the position still changes,
 * instantly.
 */
/**
 * The element that genuinely scrolls at the current width. Above the 700px
 * breakpoint the article owns a bounded box; below it the article flows and the
 * stage around it scrolls instead. Reading position, and the arrow keys, must
 * follow the real scroller -- watching the article at narrow widths persists a
 * position that is always zero, silently, with nothing in the interface to say
 * so.
 */
function scrollOwner(article: HTMLElement | null): HTMLElement | null {
  if (!article) return null;
  if (article.scrollHeight > article.clientHeight + 1) return article;
  const stage = article.parentElement;
  // Named explicitly rather than trusting "the parent": a wrapper introduced
  // later would otherwise silently make this measure the wrong element.
  if (stage?.classList.contains('scroll-layout') && stage.scrollHeight > stage.clientHeight + 1) return stage;
  return article;
}

/** How far through the scrollable range the reader is, 0 to 1. Carried across a
 *  change of scroll owner, because the same text occupies a different height in
 *  a narrower column, so an absolute offset would land somewhere else. */
function scrollFraction(node: HTMLElement | null): number {
  if (!node) return 0;
  const range = node.scrollHeight - node.clientHeight;
  return range > 0 ? node.scrollTop / range : 0;
}

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
  onReturnBranch?: () => void;
  onOpenKeep?: () => void;
  onRetry: () => void;
  onReadingPosition: (assetId: string, position: number) => void;
  /** #133: the store's recorded explanation of the encounter on screen ("What led here"). Optional
   * and additive: without it the "Why this appeared" panel is exactly what it was before. */
  why?: WhyView;
  onOpenWhy?: () => void;
  onCloseWhy?: () => void;
  onRetryWhy?: () => void;
  onCorrect?: (kind: EncounterFeedbackKind) => void;
  branchPanel?: ReactNode;
  representation?: 'Reel' | 'Scroll';
  onSwitchRepresentation?: (kind: 'Reel' | 'Scroll') => void;
}

/** The "What led here" controls, grouped so ReadingStage's parameters stay readable. */
interface WhyControls {
  view?: WhyView;
  onOpen: () => void;
  onClose: () => void;
  onRetry: () => void;
  onCorrect: (kind: EncounterFeedbackKind) => void;
}

const noop = () => {};

/** Only these seven truth states have a documented presentation (definition.md sec.12); anything
 * else falls back to the neutral base `.truth-pill` tint rather than guessing a colour. */
const KNOWN_TRUTH_STATES = new Set(['documented', 'synthesis', 'interpretation', 'disputed', 'modelled', 'counterfactual', 'fictional']);

function truthPillClassName(truthState: string): string {
  const slug = truthState.toLowerCase();
  return KNOWN_TRUTH_STATES.has(slug) ? `truth-pill state-${slug}` : 'truth-pill';
}

export function ScrollScreen({
  state,
  onVisible,
  onKeep,
  onNext,
  onReturn,
  onReturnBranch,
  onOpenKeep = onReturn,
  onRetry,
  onReadingPosition,
  why,
  onOpenWhy = noop,
  onCloseWhy = noop,
  onRetryWhy = noop,
  onCorrect = noop,
  branchPanel,
  representation = 'Scroll',
  onSwitchRepresentation,
}: ScrollScreenProps) {
  if (state.status === 'reading') {
    if (state.item.kind === 'Reel') {
      return <main className="scroll-screen" aria-label="Reel pending player">This Reel is unavailable in the Scroll reader.</main>;
    }
    return (
      <ReadingStage
        key={state.item.assetId}
        state={state}
        onVisible={onVisible}
        onKeep={onKeep}
        onNext={onNext}
        onReturn={onReturn} onOpenKeep={onOpenKeep}
        onReturnBranch={onReturnBranch}
        onReadingPosition={onReadingPosition}
        why={{ view: why, onOpen: onOpenWhy, onClose: onCloseWhy, onRetry: onRetryWhy, onCorrect }}
        branchPanel={branchPanel}
        onSwitchRepresentation={onSwitchRepresentation}
      />
    );
  }
  if (state.status === 'unavailable') {
    return <RestScreen title="This Scroll is unavailable" message={state.message} exhausted={false} onReturn={onReturn} onOpenKeep={onOpenKeep} onRetry={onRetry} retryable={state.retryable} representation={representation} onSwitchRepresentation={onSwitchRepresentation} />;
  }
  if (state.status === 'exhausted') {
    return (
      <RestScreen
        title={representation === 'Reel' ? 'No Reels available right now' : "You've reached the end of the current library"}
        message={representation === 'Reel' ? 'Choose Scroll to keep reading, or return to your Universe.' : 'There is no unread encounter left right now. Check back later, or revisit a saved Trace.'}
        exhausted
        onReturn={onReturn} onOpenKeep={onOpenKeep}
        onRetry={onRetry}
        retryable
        representation={representation}
        onSwitchRepresentation={onSwitchRepresentation}
      />
    );
  }
  return (
    <main className="scroll-screen" aria-label="Scroll" aria-busy="true">
      <p role="status" aria-live="polite">
        Preparing your next encounter…
      </p>
    </main>
  );
}

/** Shared destinations remain reachable from reading, rest and recovery. */
function ScrollDock({ onReturn, onOpenKeep = onReturn }: { onReturn: () => void; onOpenKeep?: () => void }) {
  return (
    <nav className="universe-dock" aria-label="Main navigation">
      <button type="button" className="dock-button current" aria-current="page" onClick={() => {}} aria-label="Cable — read a Scroll">
        <span className="dock-icon" aria-hidden="true">
          〜
        </span>
        Cable
      </button>
      <button type="button" className="dock-button" onClick={onReturn} aria-label="Atlas — your universe">
        <span className="dock-icon" aria-hidden="true">
          ◎
        </span>
        Atlas
      </button>
      <button type="button" className="dock-button" onClick={onOpenKeep} aria-label="Keep — your saved Traces">
        <span className="dock-icon" aria-hidden="true">
          ▱
        </span>
        Keep
      </button>
    </nav>
  );
}

function RestScreen({
  title,
  message,
  exhausted,
  onReturn,
  onOpenKeep = onReturn,
  onRetry,
  retryable,
  representation = 'Scroll',
  onSwitchRepresentation,
}: {
  title: string;
  message: string;
  exhausted: boolean;
  onReturn: () => void;
  onOpenKeep?: () => void;
  onRetry: () => void;
  retryable: boolean;
  representation?: 'Reel' | 'Scroll';
  onSwitchRepresentation?: (kind: 'Reel' | 'Scroll') => void;
}) {
  return (
    <main className="scroll-screen rest-screen" aria-label="Scroll">
      <div className="rest-card">
        {onSwitchRepresentation && <RepresentationSwitch selected={representation} onSelect={onSwitchRepresentation} />}
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
      <ScrollDock onReturn={onReturn} onOpenKeep={onOpenKeep} />
    </main>
  );
}

function ReadingStage({
  state,
  onVisible,
  onKeep,
  onNext,
  onReturn,
  onReturnBranch,
  onOpenKeep = onReturn,
  onReadingPosition,
  why,
  branchPanel,
  onSwitchRepresentation,
}: {
  state: Extract<ScrollView, { status: 'reading' }>;
  onVisible: (assetId: string) => void;
  onKeep: () => void;
  onNext: () => void;
  onReturn: () => void;
  onReturnBranch?: () => void;
  onOpenKeep?: () => void;
  onReadingPosition: (assetId: string, position: number) => void;
  why: WhyControls;
  branchPanel?: ReactNode;
  onSwitchRepresentation?: (kind: 'Reel' | 'Scroll') => void;
}) {
  const { item } = state;
  if (item.kind !== 'Scroll') throw new Error('ReadingStage requires a Scroll');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const whyTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Held in a ref so the keyboard listener below (re-bound only when a panel opens or closes) always
  // reaches the current store callbacks.
  const whyRef = useRef(why);
  whyRef.current = why;
  const openWhy = useCallback(() => {
    setSourcesOpen(false);
    setWhyOpen(true);
    whyRef.current.onOpen();
  }, []);
  /** `restoreFocus`: Escape hands focus back to the trigger, so a keyboard reader is never left on <body>. */
  const closeWhy = useCallback((restoreFocus: boolean) => {
    setWhyOpen(false);
    whyRef.current.onClose();
    if (restoreFocus) whyTriggerRef.current?.focus();
  }, []);
  const stageRef = useRef<HTMLElement | null>(null);
  const [stageNode, setStageNode] = useState<HTMLElement | null>(null);
  const stageRefCallback = useCallback((node: HTMLElement | null) => {
    stageRef.current = node;
    setStageNode(node);
  }, []);

  useVisibleExposure(stageNode, item.assetId, onVisible);

  useEffect(() => {
    const article = stageRef.current;
    if (!article) return undefined;
    const stage = article.parentElement;
    const owner = () => scrollOwner(article);
    const restored = owner();
    if (restored) restored.scrollTop = state.readingPosition;

    // Both candidates are observed, because which one scrolls depends on the
    // viewport width and can change under a resize while the Scroll is open.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let current = restored;
    let depth = scrollFraction(restored);
    const onScroll = (event: Event) => {
      // A breakpoint can reset the old scroll owner before resize is dispatched.
      // Its queued scroll event must not overwrite the last known depth with the new owner's zero.
      if (owner() !== current || event.target !== current) return;
      // Read synchronously: by the time a resize handler runs, the element that
      // was scrolling has already been reset to zero and the depth is gone.
      depth = scrollFraction(owner());
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onReadingPosition(item.assetId, owner()?.scrollTop ?? 0), 200);
    };
    const onResize = () => {
      const next = owner();
      if (!next || next === current) return;
      // The owner changed, so the reader's place has to be carried onto it --
      // crossing the breakpoint otherwise drops them back to the top of the
      // article, which is an ordinary thing to do to a window.
      const range = next.scrollHeight - next.clientHeight;
      next.scrollTop = range > 0 ? Math.round(depth * range) : 0;
      current = next;
      onReadingPosition(item.assetId, next.scrollTop);
    };
    article.addEventListener('scroll', onScroll);
    stage?.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onResize);
    return () => {
      if (timeout) clearTimeout(timeout);
      onReadingPosition(item.assetId, owner()?.scrollTop ?? 0);
      article.removeEventListener('scroll', onScroll);
      stage?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
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
      // discovery by accident. Branches have their own explicit controls;
      // ArrowRight is left to the enclosing encounter gesture only when it
      // has a currently available continuation.
      if (event.key === 'ArrowDown' && !sourcesOpen && !whyOpen) {
        event.preventDefault();
        if (scrollReadingColumn(scrollOwner(stageRef.current), SCROLL_STEP)) return;
        onNext();
        return;
      }
      if (event.key === 'ArrowUp' && !sourcesOpen && !whyOpen) {
        event.preventDefault();
        scrollReadingColumn(scrollOwner(stageRef.current), -SCROLL_STEP);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (whyOpen) {
          closeWhy(true);
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
        if (whyOpen) closeWhy(false);
        setSourcesOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sourcesOpen, whyOpen, onNext, onReturn, closeWhy]);

  const originLabel = state.origin.type === 'saved-trace'
    ? 'Saved Trace · revisiting a kept Scroll'
    : state.origin.type === 'branch'
      ? `${state.origin.recorded ? 'Connection' : 'Unrecorded connection'} · ${state.origin.relationPhrase} from ${state.origin.fromTitle}`
      : 'Deliberate discovery · a new encounter';
  const unrecordedBranch = state.origin.type === 'branch' && !state.origin.recorded;
  const truthMeaning = TRUTH_STATE_MEANING[item.truthState] ?? 'No documented meaning is defined for this truth state.';
  const contextAfter = import.meta.env.DEV && new URLSearchParams(window.location.search).get('webVariant') === 'context-after';

  return (
    <main className="scroll-screen reading" aria-label="Scroll reader">
      <header className="head-band">
        <button type="button" className="pill cream" onClick={onReturn} aria-label="Return to Universe" aria-keyshortcuts="Escape">
          ‹ Universe
        </button>
        {onSwitchRepresentation && <RepresentationSwitch selected="Scroll" onSelect={onSwitchRepresentation} disabled={state.discovery === 'loading' || state.keep.status === 'saving'} />}
        {state.origin.type === 'branch' && onReturnBranch
          ? <button type="button" className="head-band-origin head-band-origin--action" onClick={onReturnBranch} aria-label="Return to origin">← {originLabel}</button>
          : <span className="head-band-origin">{originLabel}</span>}
        <span className={`${truthPillClassName(item.truthState)} head-band-state`}>{item.truthState.toUpperCase()}</span>
      </header>
      <div className={`scroll-layout${contextAfter ? ' scroll-layout--context-after' : ''}`}>
        <aside className="context-rail" aria-label="Context">
          <button
            type="button"
            className="pill cream"
            onClick={() => {
              if (whyOpen) closeWhy(false);
              setSourcesOpen(v => !v);
            }}
            aria-expanded={sourcesOpen}
            aria-label={sourcesOpen ? 'Close context panel' : 'Open context panel'}
            aria-keyshortcuts="s"
          >
            Context
          </button>
          <button
            type="button"
            className="pill cream"
            aria-expanded={whyOpen}
            ref={whyTriggerRef}
            onClick={() => (whyOpen ? closeWhy(false) : openWhy())}
          >
            Why this appeared
          </button>
          <span className="reading-gesture-hint">Swipe ↑ for next · ← for connections</span>
          {whyOpen && (
            <WhyThisAppeared
              item={item}
              origin={originLabel}
              truthMeaning={truthMeaning}
              // Only an explanation of *this* Scroll is ever shown here.
              whyView={why.view?.status === 'open' && why.view.assetId === item.assetId ? why.view : undefined}
              onCorrect={why.onCorrect}
              onRetry={why.onRetry}
            />
          )}
        </aside>
        {sourcesOpen && <SourceRail item={item} truthMeaning={truthMeaning} onClose={() => setSourcesOpen(false)} />}
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
          <NativeScroll embedded item={item} />
          {branchPanel}
          <div className="continue">
            {unrecordedBranch && <p role="status">Recording is paused. This connection is for reading only; it cannot be kept.</p>}
            {(state.keep.status === 'failed' || state.keep.status === 'conflict') && (
              <p role="alert" className="keep-message">
                {state.keep.message}
              </p>
            )}
            <button
              type="button"
              className="pill yellow"
              onClick={onKeep}
              disabled={unrecordedBranch || state.keep.status === 'saving' || state.keep.status === 'kept' || state.discovery === 'loading'}
              aria-label={state.keep.status === 'kept' ? 'Kept' : state.keep.status === 'saving' ? 'Keeping…' : 'Keep this Scroll'}
            >
              {/* Cosmos's own label (ui-system.md sec.5b: "Keep this", yellow) -- the
                  accessible name stays "Keep this Scroll" above so existing journeys
                  and tests keep working unchanged. */}
              {state.keep.status === 'kept' ? 'Kept' : state.keep.status === 'saving' ? 'Keeping…' : 'Keep this'}
            </button>
            <DiscoveryThreshold keep={state.keep} discovery={state.discovery} onNext={onNext} />
          </div>
        </article>
      </div>
      <p className="keyboard-help">Keyboard: ↓ reads on, then takes the next discovery · N next · S context · Escape or Home returns to Universe.</p>
      <ScrollDock onReturn={onReturn} onOpenKeep={onOpenKeep} />
    </main>
  );
}

function WhyThisAppeared({
  item,
  origin,
  truthMeaning,
  whyView,
  onCorrect,
  onRetry,
}: {
  item: { reason: string; truthState: string };
  origin: string;
  truthMeaning: string;
  whyView?: Extract<WhyView, { status: 'open' }>;
  onCorrect: (kind: EncounterFeedbackKind) => void;
  onRetry: () => void;
}) {
  // Focus moves into the panel when it opens, like the source panel (SourceRail below).
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  const reasonText = item.reason.trim().length > 0 ? item.reason : 'No explanation recorded.';
  return (
    <section className="why-this-appeared" aria-label="Why this appeared" ref={panelRef} tabIndex={-1}>
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
      {whyView && <WhatLedHere view={whyView} onCorrect={onCorrect} onRetry={onRetry} />}
    </section>
  );
}

function DiscoveryThreshold({ keep, discovery, onNext }: { keep: KeepState; discovery: DiscoveryState; onNext: () => void }) {
  const disabled = discovery === 'loading' || keep.status === 'saving' || keep.status === 'failed' || keep.status === 'conflict';
  return (
    <section className="discovery-threshold" aria-label="Next discovery">
      <h3>{discovery === 'exhausted' ? "You've reached the end of the current library" : 'Ready for another encounter?'}</h3>
      {discovery === 'failed' && <p role="alert">The next Scroll could not be loaded. Try again.</p>}
      {discovery === 'loading' && (
        <p role="status" aria-live="polite">
          Finding the next encounter…
        </p>
      )}
      <button type="button" className="pill teal" onClick={onNext} disabled={disabled} aria-label="Next discovery" aria-keyshortcuts="n ArrowDown">
        {/* Cosmos's own label (ui-system.md sec.5b: "keep going →", teal). Accessible
            name stays "Next discovery" so existing journeys and tests keep working. */}
        {discovery === 'failed' ? 'Retry next' : discovery === 'exhausted' ? 'Check again' : 'keep going →'}
      </button>
    </section>
  );
}

function SourceRail({ item, truthMeaning, onClose }: { item: { title: string; truthState: string }; truthMeaning: string; onClose: () => void }) {
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    railRef.current?.focus();
  }, []);
  return (
    <aside className="source-sheet" aria-label="Scroll context" ref={railRef} tabIndex={-1}>
      <div className="source-sheet-header">
        <h3>About this Scroll</h3>
        {/* Distinct accessible name from the context-rail toggle (which already
            reads "Close sources panel" once open): two controls performing
            the same action must not share one name. */}
        <button type="button" className="pill ghost" onClick={onClose} aria-label="Close the context panel" aria-keyshortcuts="Escape">
          Close
        </button>
      </div>
      <div className="truth-line on-cream">
        <span className={truthPillClassName(item.truthState)}>{item.truthState.toUpperCase()}</span>
        <span className="truth-meaning">{truthMeaning}</span>
      </div>
      <p className="source-title">{item.title}</p>
      <p className="source-url">Source details are kept outside the reader view.</p>
    </aside>
  );
}
