import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EncounterGesture } from '../../src/components/EncounterGesture.tsx';

function pointer(target: Element, phase: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', values: Record<string, unknown>) {
  fireEvent[phase](target, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    timeStamp: 10,
    ...values,
  });
}

describe('EncounterGesture', () => {
  it('follows the finger and advances only after a committed settle', async () => {
    const onNext = vi.fn();
    const { container } = render(<EncounterGesture onNext={onNext}><article>Encounter copy</article></EncounterGesture>);
    const surface = container.querySelector('.encounter-gesture__surface')!;
    pointer(surface, 'pointerDown', { clientX: 160, clientY: 300, timeStamp: 10 });
    pointer(surface, 'pointerMove', { clientX: 162, clientY: 180, timeStamp: 110 });
    expect(surface).toHaveStyle('--encounter-follow-y: -45.6px');
    expect(onNext).not.toHaveBeenCalled();
    pointer(surface, 'pointerUp', { clientX: 162, clientY: 180, timeStamp: 210 });
    expect(onNext).not.toHaveBeenCalled();
    expect(surface).toHaveStyle('--encounter-follow-y: 0px');
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });

  it('cancels a short drag without advancing', () => {
    const onNext = vi.fn();
    const { container } = render(<EncounterGesture onNext={onNext}><article>Encounter copy</article></EncounterGesture>);
    const surface = container.querySelector('.encounter-gesture__surface')!;
    pointer(surface, 'pointerDown', { clientX: 160, clientY: 300, timeStamp: 10 });
    pointer(surface, 'pointerMove', { clientX: 160, clientY: 275, timeStamp: 80 });
    pointer(surface, 'pointerUp', { clientX: 160, clientY: 275, timeStamp: 100 });
    expect(onNext).not.toHaveBeenCalled();
    expect(surface).toHaveStyle('--encounter-follow-y: 0px');
  });

  it('transfers an upward swipe only at the inner scroll boundary', async () => {
    const onNext = vi.fn();
    const { container } = render(
      <EncounterGesture onNext={onNext}>
        <article data-testid="reading" style={{ overflowY: 'auto' }}><div>Long reading</div></article>
      </EncounterGesture>,
    );
    const surface = container.querySelector('.encounter-gesture__surface')!;
    const article = screen.getByTestId('reading');
    Object.defineProperties(article, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 80 },
    });
    pointer(article, 'pointerDown', { clientX: 180, clientY: 280, timeStamp: 10 });
    pointer(article, 'pointerMove', { clientX: 180, clientY: 150, timeStamp: 100 });
    expect(surface).toHaveStyle('--encounter-follow-y: 0px');
    pointer(article, 'pointerUp', { clientX: 180, clientY: 150, timeStamp: 120 });
    expect(onNext).not.toHaveBeenCalled();

    article.scrollTop = 300;
    pointer(article, 'pointerDown', { clientX: 180, clientY: 280, timeStamp: 200 });
    pointer(article, 'pointerMove', { clientX: 180, clientY: 150, timeStamp: 300 });
    expect(surface).not.toHaveStyle('--encounter-follow-y: 0px');
    pointer(article, 'pointerUp', { clientX: 180, clientY: 150, timeStamp: 400 });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });

  it('preserves child control ownership and the left edge browser-back reservation', () => {
    const onNext = vi.fn();
    const { container } = render(<EncounterGesture onNext={onNext}><button>Play</button><article>Copy</article></EncounterGesture>);
    const surface = container.querySelector('.encounter-gesture__surface')!;
    pointer(screen.getByRole('button', { name: 'Play' }), 'pointerDown', { clientX: 100, clientY: 220, timeStamp: 10 });
    pointer(screen.getByRole('button', { name: 'Play' }), 'pointerMove', { clientX: 100, clientY: 80, timeStamp: 100 });
    pointer(screen.getByRole('button', { name: 'Play' }), 'pointerUp', { clientX: 100, clientY: 80, timeStamp: 200 });
    pointer(surface, 'pointerDown', { clientX: 8, clientY: 220, timeStamp: 300 });
    pointer(surface, 'pointerMove', { clientX: 8, clientY: 80, timeStamp: 400 });
    pointer(surface, 'pointerUp', { clientX: 8, clientY: 80, timeStamp: 500 });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('leaves horizontal motion unavailable without a branch callback', () => {
    const onNext = vi.fn();
    const { container } = render(<EncounterGesture onNext={onNext}><article>Encounter copy</article></EncounterGesture>);
    const surface = container.querySelector('.encounter-gesture__surface')!;
    pointer(surface, 'pointerDown', { clientX: 200, clientY: 250, timeStamp: 10 });
    pointer(surface, 'pointerMove', { clientX: 80, clientY: 248, timeStamp: 100 });
    pointer(surface, 'pointerUp', { clientX: 80, clientY: 248, timeStamp: 200 });
    expect(onNext).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Next branch' })).not.toBeInTheDocument();
  });

  it('offers button and focused keyboard alternatives', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { container } = render(<EncounterGesture onNext={onNext} onPrevious={onPrevious} showControls><article>Copy</article></EncounterGesture>);
    fireEvent.click(screen.getByRole('button', { name: 'Next encounter' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    const surface = container.querySelector('.encounter-gesture__surface')!;
    fireEvent.keyDown(surface, { key: 'ArrowUp' });
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('keeps a native touch gesture through pointercancel until touchend', async () => {
    const onNext = vi.fn();
    const { container } = render(<EncounterGesture onNext={onNext}><article>Reel</article></EncounterGesture>);
    const surface = container.querySelector('.encounter-gesture__surface')!;
    fireEvent.touchStart(surface, { touches: [{ clientX: 160, clientY: 300 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 160, clientY: 170 }] });
    pointer(surface, 'pointerCancel', { pointerId: 5 });
    expect(onNext).not.toHaveBeenCalled();
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 160, clientY: 170 }] });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });
});
