import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react';
import './encounter-gesture.css';

/** Tunable gesture thresholds, kept together so phone tuning is predictable. */
export const ENCOUNTER_GESTURE_CONFIG = {
  edgeReservationPx: 24,
  directionLockRatio: 1.2,
  directionLockDistancePx: 10,
  commitDistancePx: 88,
  fastCommitDistancePx: 42,
  fastCommitVelocityPxPerMs: 0.65,
  followRatio: 0.38,
  maxFollowPx: 150,
} as const;

export interface EncounterGestureProps {
  children: ReactNode;
  onNext: () => void;
  onPrevious?: () => void;
  /** Horizontal branches are offered only when a caller can actually open them. */
  onBranchPrevious?: () => void;
  onBranchNext?: () => void;
  className?: string;
  previousLabel?: string;
  nextLabel?: string;
  branchNextLabel?: string;
  branchPreviousLabel?: string;
  showControls?: boolean;
  keyboardNavigation?: boolean;
}

type Axis = 'vertical' | 'horizontal' | null;
interface GestureStart {
  pointerId: number;
  x: number;
  y: number;
  time: number;
  axis: Axis;
  owner: HTMLElement;
  edgeReserved: boolean;
  dragging: boolean;
  scrollTopAtStart: number;
  scrollMaxAtStart: number;
}

const OWNED_SELECTOR = [
  'button', 'a[href]', 'input', 'textarea', 'select', 'option', 'video', 'audio', 'canvas',
  '[contenteditable="true"]', '[role="button"]', '[data-gesture-owner]',
].join(',');

function ownsGesture(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(OWNED_SELECTOR));
}

function scrollBoundaryOwner(target: EventTarget | null, surface: HTMLElement): HTMLElement {
  if (!(target instanceof Element)) return surface;
  let node: HTMLElement | null = target as HTMLElement;
  while (node && node !== surface) {
    const style = window.getComputedStyle(node);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    if (scrollable) return node;
    node = node.parentElement;
  }
  return surface;
}

function atBoundary(owner: HTMLElement, swipeDeltaY: number): boolean {
  // A finger moving up advances down through the reading column.
  if (swipeDeltaY < 0) return owner.scrollTop + owner.clientHeight >= owner.scrollHeight - 1;
  return owner.scrollTop <= 0;
}

function startedAtBoundary(start: GestureStart, swipeDeltaY: number): boolean {
  if (swipeDeltaY < 0) return start.scrollTopAtStart >= start.scrollMaxAtStart - 1;
  return start.scrollTopAtStart <= 1;
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function EncounterGesture({
  children,
  onNext,
  onPrevious,
  onBranchPrevious,
  onBranchNext,
  className = '',
  previousLabel = 'Previous encounter',
  nextLabel = 'Next encounter',
  branchNextLabel = 'Explore connection',
  branchPreviousLabel = 'Return along connection',
  showControls = false,
  keyboardNavigation = true,
}: EncounterGestureProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureStart | null>(null);
  const callbacksRef = useRef({ onNext, onPrevious, onBranchPrevious, onBranchNext });
  callbacksRef.current = { onNext, onPrevious, onBranchPrevious, onBranchNext };
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [settling, setSettling] = useState(false);
  const [inlineActionsVisible, setInlineActionsVisible] = useState(false);
  const settleTimer = useRef<number | null>(null);
  const locked = useRef(false);

  useEffect(() => () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
  }, []);

  // When the Scroll's own Next/Connections section comes into view, it owns
  // those taps. The floating swipe affordance must leave its buttons clear.
  useEffect(() => {
    const threshold = surfaceRef.current?.querySelector('.discovery-threshold');
    if (!threshold || !showControls) {
      setInlineActionsVisible(false);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setInlineActionsVisible(Boolean(entry?.isIntersecting));
    }, { threshold: 0.01 });
    observer.observe(threshold);
    return () => observer.disconnect();
  }, [children, showControls]);

  const clearGesture = useCallback((commit: 'next' | 'previous' | 'branch-previous' | 'branch-next' | null) => {
    gestureRef.current = null;
    setOffset({ x: 0, y: 0 });
    setSettling(true);
    locked.current = commit !== null;
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    const settleMs = reducedMotion() ? 0 : 220;
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      locked.current = false;
      setSettling(false);
      if (commit === 'next') callbacksRef.current.onNext();
      if (commit === 'previous') callbacksRef.current.onPrevious?.();
      if (commit === 'branch-previous') callbacksRef.current.onBranchPrevious?.();
      if (commit === 'branch-next') callbacksRef.current.onBranchNext?.();
    }, settleMs);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Text selection owns prose. Mouse drags from the surrounding reading surface give desktop
    // users a spatial preview without turning every text selection into navigation.
    // Trusted touch input uses Touch Events below: the browser may issue pointercancel when it
    // takes native pan-y, while touchend still reaches the boundary-transfer decision.
    if (!event.isPrimary || event.button !== 0 || (event.pointerType === 'touch' && event.nativeEvent.isTrusted) || locked.current || ownsGesture(event.target)) return;
    if (event.pointerType === 'mouse' && event.target instanceof Element && event.target.closest('p, h1, h2, h3, li, blockquote, q, pre, code, figcaption')) return;
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
      setSettling(false);
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    const edgeReserved = event.pointerType === 'touch' && event.clientX <= ENCOUNTER_GESTURE_CONFIG.edgeReservationPx;
    const owner = scrollBoundaryOwner(event.target, surface);
    gestureRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      axis: null,
      owner,
      edgeReserved,
      dragging: false,
      scrollTopAtStart: owner.scrollTop,
      scrollMaxAtStart: Math.max(0, owner.scrollHeight - owner.clientHeight),
    };
  };

  const moveGesture = (clientX: number, clientY: number): boolean => {
    const start = gestureRef.current;
    if (!start || start.edgeReserved) return false;
    const dx = clientX - start.x;
    const dy = clientY - start.y;
    if (!start.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= ENCOUNTER_GESTURE_CONFIG.directionLockDistancePx) {
      if (Math.abs(dy) > Math.abs(dx) * ENCOUNTER_GESTURE_CONFIG.directionLockRatio) start.axis = 'vertical';
      else if (Math.abs(dx) > Math.abs(dy) * ENCOUNTER_GESTURE_CONFIG.directionLockRatio) start.axis = 'horizontal';
      else return false;
    }
    if (!start.axis) return false;
    if (start.axis === 'horizontal') {
      const direction = dx < 0 ? 'branch-next' : 'branch-previous';
      if (!callbacksRef.current[direction === 'branch-next' ? 'onBranchNext' : 'onBranchPrevious']) return false;
      start.dragging = true;
      setOffset({ x: Math.max(-ENCOUNTER_GESTURE_CONFIG.maxFollowPx, Math.min(ENCOUNTER_GESTURE_CONFIG.maxFollowPx, dx * ENCOUNTER_GESTURE_CONFIG.followRatio)), y: 0 });
      return true;
    }
    if (dy > 0 && !callbacksRef.current.onPrevious) return false;
    if (!startedAtBoundary(start, dy) || !atBoundary(start.owner, dy)) return false;
    start.dragging = true;
    setOffset({ x: 0, y: Math.max(-ENCOUNTER_GESTURE_CONFIG.maxFollowPx, Math.min(ENCOUNTER_GESTURE_CONFIG.maxFollowPx, dy * ENCOUNTER_GESTURE_CONFIG.followRatio)) });
    return true;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = gestureRef.current;
    if (!start || event.pointerId !== start.pointerId) return;
    if (moveGesture(event.clientX, event.clientY) && event.cancelable) event.preventDefault();
  };

  const finishGesture = (clientX: number, clientY: number, timeStamp: number) => {
    const start = gestureRef.current;
    if (!start) return;
    if (start.edgeReserved || !start.dragging || !start.axis) {
      clearGesture(null);
      return;
    }
    const dx = clientX - start.x;
    const dy = clientY - start.y;
    const elapsed = Math.max(1, timeStamp - start.time);
    const distance = start.axis === 'vertical' ? dy : dx;
    const velocity = Math.abs(distance) / elapsed;
    const committed = Math.abs(distance) >= ENCOUNTER_GESTURE_CONFIG.commitDistancePx ||
      (Math.abs(distance) >= ENCOUNTER_GESTURE_CONFIG.fastCommitDistancePx && velocity >= ENCOUNTER_GESTURE_CONFIG.fastCommitVelocityPxPerMs);
    if (!committed) {
      clearGesture(null);
      return;
    }
    if (start.axis === 'vertical') {
      clearGesture(distance < 0 ? 'next' : 'previous');
    } else {
      const commit = distance < 0 ? 'branch-next' : 'branch-previous';
      clearGesture(callbacksRef.current[commit === 'branch-next' ? 'onBranchNext' : 'onBranchPrevious'] ? commit : null);
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) finishGesture(event.clientX, event.clientY, event.timeStamp);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) clearGesture(null);
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1 || locked.current || ownsGesture(event.target)) return;
    const touch = event.touches[0];
    const surface = surfaceRef.current;
    if (!touch || !surface) return;
    const owner = scrollBoundaryOwner(event.target, surface);
    gestureRef.current = {
      pointerId: -1,
      x: touch.clientX,
      y: touch.clientY,
      time: event.timeStamp,
      axis: null,
      owner,
      edgeReserved: touch.clientX <= ENCOUNTER_GESTURE_CONFIG.edgeReservationPx,
      dragging: false,
      scrollTopAtStart: owner.scrollTop,
      scrollMaxAtStart: Math.max(0, owner.scrollHeight - owner.clientHeight),
    };
  };
  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== -1 || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch) moveGesture(touch.clientX, touch.clientY);
  };
  const onTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== -1) return;
    const touch = event.changedTouches[0];
    if (touch) finishGesture(touch.clientX, touch.clientY, event.timeStamp);
    else clearGesture(null);
  };
  const onTouchCancel = () => {
    if (gestureRef.current?.pointerId === -1) clearGesture(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!keyboardNavigation || event.altKey || event.ctrlKey || event.metaKey || ownsGesture(event.target)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      callbacksRef.current.onNext();
    } else if (event.key === 'ArrowUp' && callbacksRef.current.onPrevious) {
      event.preventDefault();
      callbacksRef.current.onPrevious();
    } else if (event.key === 'ArrowLeft' && callbacksRef.current.onBranchPrevious) {
      event.preventDefault();
      callbacksRef.current.onBranchPrevious();
    } else if (event.key === 'ArrowRight' && callbacksRef.current.onBranchNext) {
      event.preventDefault();
      callbacksRef.current.onBranchNext();
    }
  };

  const style = { '--encounter-follow-x': `${offset.x}px`, '--encounter-follow-y': `${offset.y}px` } as React.CSSProperties;
  return (
    <section className={`encounter-gesture ${className}`.trim()} aria-label="Encounter navigation">
      <div
        ref={surfaceRef}
        className={`encounter-gesture__surface${settling ? ' is-settling' : ''}`}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onKeyDown={onKeyDown}
        tabIndex={0}
        aria-label="Encounter. Use the arrow keys to navigate."
      >
        {children}
      </div>
      {showControls && !inlineActionsVisible && <nav className="encounter-gesture__controls" aria-label="Swipe and encounter navigation">
        <span className="encounter-gesture__legend">SWIPE</span>
        {onPrevious && <button type="button" onClick={onPrevious} aria-label={previousLabel}><span aria-hidden="true">↓</span>{previousLabel}</button>}
        <button type="button" onClick={onNext} aria-label={nextLabel}><span aria-hidden="true">↑</span>Next</button>
        {onBranchPrevious && <button type="button" onClick={onBranchPrevious} aria-label={branchPreviousLabel}><span aria-hidden="true">→</span>{branchPreviousLabel}</button>}
        {onBranchNext && <button type="button" onClick={onBranchNext} aria-label={branchNextLabel}><span aria-hidden="true">←</span>Connection</button>}
      </nav>}
    </section>
  );
}
