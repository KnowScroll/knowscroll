import { useRef, type ReactNode } from 'react';
import { createGestureArbitrator, type EncounterGestureMove } from './arbitration';

/** DOM pointer ownership lives only on the real video stage; player buttons/seek controls stay outside. */
export function ReelGestureStage({
  children,
  onMove,
  onToggle,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: EncounterGestureMove) => void;
  /** Space on the focused stage plays or pauses, as the focused play button would. */
  readonly onToggle?: () => void;
}) {
  const gesture = useRef<ReturnType<typeof createGestureArbitrator> | undefined>(undefined);
  const start = useRef({ x: 0, y: 0, pointerId: -1 });
  return (
    <div
      style={{ display: 'flex', flex: 1, minHeight: 0, touchAction: 'none', userSelect: 'none' }}
      data-testid="reel-navigation-stage"
      tabIndex={0}
      role="group"
      aria-label="Reel navigation"
      onKeyDown={(event) => {
        // The stage and its own play/pause button are the "Reel navigation" focus stops; any other
        // control inside keeps its own keys.
        const target = event.target as Element;
        const onStage = target === event.currentTarget || target.getAttribute('data-testid') === 'reel-playback-toggle';
        if (!onStage) return;
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
        // A control inside the stage owns its pointer, except the play/pause surface that fills the
        // whole stage: a drag across it is a swipe and a tap on it is a tap.
        const control =
          event.target instanceof Element
            ? event.target.closest('button,a,input,select,textarea,[role="slider"],[contenteditable="true"]')
            : null;
        const childOwns = control !== null && control.getAttribute('data-testid') !== 'reel-playback-toggle';
        gesture.current = createGestureArbitrator({ startX: event.clientX, scroll: false, childOwns, native: false });
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== start.current.pointerId) return;
        const owner = gesture.current?.move(event.clientX - start.current.x, event.clientY - start.current.y);
        // Capture only once a swipe is recognised: a plain tap must still reach the play/pause
        // control under the pointer.
        if ((owner === 'horizontal' || owner === 'vertical') && !event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== start.current.pointerId) return;
        gesture.current?.move(event.clientX - start.current.x, event.clientY - start.current.y);
        const move = gesture.current?.release();
        gesture.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (move) onMove(move);
      }}
      onPointerCancel={() => {
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
