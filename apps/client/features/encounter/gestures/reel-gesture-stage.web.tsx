import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createGestureArbitrator, type EncounterGestureMove } from './arbitration';

/**
 * A keyboard move replaces the stage (each encounter is its own element), which would drop focus to
 * the page. A stage that held focus when it went away leaves a short-lived note, and the next stage
 * to mount takes focus, so the next key press lands.
 */
const FOCUS_HANDOVER_MS = 3000;
/** A finger held still on the video this long opens the feedback menu (P03). */
const LONG_PRESS_MS = 500;
/** A pointer that moves further than this is a swipe, not a hold. */
const HOLD_SLOP = 10;
/** The contextmenu event a phone raises after its own long press must not open the menu a second time. */
const MENU_DEBOUNCE_MS = 700;
let focusHandoverUntil = 0;

/** DOM pointer ownership lives only on the real video stage; player buttons/seek controls stay outside. */
export function ReelGestureStage({
  children,
  onMove,
  onToggle,
  onMenu,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: EncounterGestureMove) => void;
  /** Space on the focused stage plays or pauses, as the focused play button would. */
  readonly onToggle?: () => void;
  /** The feedback menu (P03): right-click, Shift+F10 or the menu key, or a finger held on the video. */
  readonly onMenu?: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = stage.current;
    if (node !== null && Date.now() < focusHandoverUntil) {
      focusHandoverUntil = 0;
      // Only when focus has nowhere to be: never pull it from a control the person has since moved to.
      const holder = document.activeElement;
      if (holder === null || holder === document.body) node.focus({ preventScroll: true });
    }
    return () => {
      if (node?.contains(document.activeElement) === true) focusHandoverUntil = Date.now() + FOCUS_HANDOVER_MS;
    };
  }, []);
  const gesture = useRef<ReturnType<typeof createGestureArbitrator> | undefined>(undefined);
  const start = useRef({ x: 0, y: 0, pointerId: -1 });
  // A finger held still on the video opens the menu; a phone's own long-press menu would answer twice.
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; openedAt: number }>({
    timer: undefined,
    openedAt: 0,
  });
  const release = () => {
    clearTimeout(hold.current.timer);
    hold.current.timer = undefined;
  };
  useEffect(() => release, []);
  const openMenu = () => {
    release();
    if (onMenu === undefined || Date.now() - hold.current.openedAt < MENU_DEBOUNCE_MS) return;
    hold.current.openedAt = Date.now();
    gesture.current?.cancel();
    onMenu();
  };
  return (
    <div
      ref={stage}
      style={{ display: 'flex', flex: 1, minHeight: 0, touchAction: 'none', userSelect: 'none' }}
      data-testid="reel-navigation-stage"
      tabIndex={0}
      role="group"
      aria-label="Reel navigation"
      onContextMenu={(event) => {
        if (onMenu === undefined) return;
        event.preventDefault();
        openMenu();
      }}
      onKeyDown={(event) => {
        // The stage and its own play/pause button are the "Reel navigation" focus stops; any other
        // control inside keeps its own keys.
        const target = event.target as Element;
        const onStage = target === event.currentTarget || target.hasAttribute('data-ks-playback-toggle');
        // Alt+Arrow is the browser's Back and Forward; Ctrl and Cmd are the person's own shortcuts.
        if (!onStage || event.altKey || event.ctrlKey || event.metaKey) return;
        if (onMenu !== undefined && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault();
          openMenu();
          return;
        }
        if (event.key === ' ' && target === event.currentTarget && onToggle) {
          event.preventDefault();
          onToggle();
          return;
        }
        const move =
          event.key === 'ArrowDown'
            ? 'subjectNext'
            : event.key === 'ArrowUp'
              ? 'subjectPrevious'
              : event.key === 'ArrowRight'
                ? 'next'
                : event.key === 'ArrowLeft'
                  ? 'previous'
                  : undefined;
        if (move) {
          event.preventDefault();
          onMove(move);
        }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) {
          gesture.current?.cancel();
          return;
        }
        start.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        release();
        if (event.pointerType === 'touch') hold.current.timer = setTimeout(openMenu, LONG_PRESS_MS);
        // A control inside the stage owns its pointer, except the play/pause surface that fills the
        // whole stage: a drag across it is a swipe and a tap on it is a tap.
        const control =
          event.target instanceof Element
            ? event.target.closest('button,a,input,select,textarea,[role="slider"],[contenteditable="true"]')
            : null;
        const childOwns = control !== null && !control.hasAttribute('data-ks-playback-toggle');
        gesture.current = createGestureArbitrator({ startX: event.clientX, scroll: false, childOwns, native: false });
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== start.current.pointerId) return;
        if (
          Math.abs(event.clientX - start.current.x) > HOLD_SLOP ||
          Math.abs(event.clientY - start.current.y) > HOLD_SLOP
        )
          release();
        const owner = gesture.current?.move(event.clientX - start.current.x, event.clientY - start.current.y);
        // Capture only once a swipe is recognised: a plain tap must still reach the play/pause
        // control under the pointer.
        if ((owner === 'horizontal' || owner === 'vertical') && !event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        release();
        if (event.pointerId !== start.current.pointerId) return;
        gesture.current?.move(event.clientX - start.current.x, event.clientY - start.current.y);
        const move = gesture.current?.release();
        gesture.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (move) onMove(move);
      }}
      onPointerCancel={() => {
        release();
        gesture.current?.cancel();
        gesture.current = undefined;
      }}
      onLostPointerCapture={() => {
        gesture.current?.cancel();
        gesture.current = undefined;
      }}
    >
      {children}
    </div>
  );
}
