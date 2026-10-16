import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OriginExperience, type OriginEnd } from '../../src/cosmos/OriginExperience.tsx';

/**
 * jsdom has no WebGL, so the real renderer refuses to start and the opening must take its CSS
 * path. These tests drive that path with fake timers (the stills and live playback are covered by
 * OriginExperience.stills.test.tsx with a stand-in renderer).
 */
function renderOrigin(props: { reducedMotion?: boolean; dismiss?: 'returning' | 'unavailable' | null } = {}) {
  const onHandoff = vi.fn();
  const onEnd = vi.fn<(reason: OriginEnd) => void>();
  const view = render(
    <OriginExperience reducedMotion={props.reducedMotion ?? false} findSeedTarget={() => null} dismiss={props.dismiss ?? null} onHandoff={onHandoff} onEnd={onEnd} />,
  );
  const rerender = (dismiss: 'returning' | 'unavailable' | null) =>
    view.rerender(<OriginExperience reducedMotion={props.reducedMotion ?? false} findSeedTarget={() => null} dismiss={dismiss} onHandoff={onHandoff} onEnd={onEnd} />);
  return { ...view, rerender, onHandoff, onEnd };
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const caption = () => document.querySelector('.origin-caption')?.textContent ?? '';
/** The overlay is fading out and no longer takes input (origin.css draws both classes the same way). */
const dissolving = () => {
  const root = screen.getByTestId('origin');
  return root.classList.contains('origin--dissolve') || root.classList.contains('origin--leaving');
};

beforeEach(() => {
  vi.useFakeTimers();
  // No WebGL here, as in jsdom itself; stubbing only keeps jsdom's "not implemented" noise out.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OriginExperience without WebGL (CSS fallback)', () => {
  it('tells the two lines over a gathering cloud, hands off, then ends on its own', () => {
    const { onHandoff, onEnd } = renderOrigin();
    expect(screen.getByTestId('origin')).toHaveClass('origin--fallback');
    expect(document.querySelector('.origin-fallback-cloud')).toBeInTheDocument();
    expect(document.querySelector('canvas')).toBeNull();
    // Sound belongs to the full opening only.
    expect(screen.queryByRole('button', { name: /Sound/ })).not.toBeInTheDocument();
    expect(caption()).toBe('');

    advance(900);
    expect(caption()).toBe('Your world began before you knew it.');
    advance(2700);
    expect(caption()).toBe('Every idea can change its shape.');
    expect(onHandoff).not.toHaveBeenCalled();
    advance(3100);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(dissolving()).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    advance(900);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('failed');
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });

  it('describes itself to assistive technology and puts focus on Skip', () => {
    renderOrigin();
    expect(screen.getByRole('region', { name: 'Opening' })).toHaveTextContent(/Use Skip, or press Escape, to go straight in/);
    expect(screen.getByRole('button', { name: 'Skip' })).toHaveFocus();
  });

  it('Skip ends at once with "skipped" and hands off exactly once, even as its timers would have fired', () => {
    const { onHandoff, onEnd } = renderOrigin();
    advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('skipped');
    expect(onHandoff).toHaveBeenCalledTimes(1);
    advance(10_000);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });

  it('Escape skips', () => {
    const { onHandoff, onEnd } = renderOrigin();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEnd).toHaveBeenCalledWith('skipped');
    expect(onHandoff).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('gives way to a returning reader: hands off at once and ends with "returning", never "failed"', () => {
    const { rerender, onHandoff, onEnd } = renderOrigin();
    advance(1200);
    expect(dissolving()).toBe(false);
    rerender('returning');
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(dissolving()).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    advance(500);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('returning');
    advance(10_000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });

  it('gives way when the Universe cannot load, ending with "failed"', () => {
    const { onEnd } = renderOrigin({ dismiss: 'unavailable' });
    advance(500);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('failed');
  });

  it('under reduced motion without WebGL still offers Skip, tells both lines and ends by itself', () => {
    const { onHandoff, onEnd } = renderOrigin({ reducedMotion: true });
    expect(screen.getByTestId('origin')).toHaveClass('origin--fallback');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    advance(3600);
    expect(caption()).toBe('Every idea can change its shape.');
    advance(4000);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('failed');
  });
});
