import { useRef, type ReactNode } from 'react';
import { createGestureArbitrator, type EncounterGestureMove } from './arbitration';

/** DOM pointer ownership lives only on the real video stage; player buttons/seek controls stay outside. */
export function ReelGestureStage({
  children,
  onMove,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: EncounterGestureMove) => void;
}) {
  const gesture = useRef<ReturnType<typeof createGestureArbitrator> | undefined>(undefined);
  const start = useRef({ x: 0, y: 0, pointerId: -1 });
  return (
    <div
      style={{ display: 'flex', flex: 1, minHeight: 0, touchAction: 'none' }}
      data-testid="reel-navigation-stage"
      tabIndex={0}
      role="group"
      aria-label="Reel navigation"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
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
        // The seam contains no controls. Keep this defensive exclusion for future interactive stage descendants.
        const childOwns =
          event.target instanceof Element &&
          event.target.closest('button,a,input,select,textarea,[role="slider"],[contenteditable="true"]') !== null;
        gesture.current = createGestureArbitrator({ startX: event.clientX, scroll: false, childOwns, native: false });
        if (!childOwns) event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.pointerId === start.current.pointerId)
          gesture.current?.move(event.clientX - start.current.x, event.clientY - start.current.y);
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
