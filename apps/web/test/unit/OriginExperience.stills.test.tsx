import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OriginExperience, type OriginEnd } from '../../src/cosmos/OriginExperience.tsx';
import { HANDOFF_START, ORIGIN_DURATION, STILLS } from '../../src/cosmos/timeline.ts';

/** A stand-in for the WebGL renderer (jsdom has none): it draws nothing and answers with the real
 * timeline frame, so the component's own playback, stills and cleanup can be observed. */
const gl = vi.hoisted(() => ({ renders: [] as number[], created: 0, disposed: 0, lost: false }));
vi.mock('../../src/cosmos/gl/OriginRenderer.ts', async () => {
  const { frameAt } = await import('../../src/cosmos/timeline.ts');
  class OriginRenderer {
    seedTarget: unknown = null;
    constructor() {
      gl.created++;
    }
    get contextLost() {
      return gl.lost;
    }
    resize() {}
    render(t: number) {
      gl.renders.push(t);
      return frameAt(t);
    }
    dispose() {
      gl.disposed++;
    }
  }
  return { OriginRenderer, chooseQuality: () => ({ webParticles: 1, materialParticles: 1, maxDpr: 1 }) };
});

function renderOrigin(reducedMotion: boolean) {
  const onHandoff = vi.fn();
  const onEnd = vi.fn<(reason: OriginEnd) => void>();
  const view = render(<OriginExperience reducedMotion={reducedMotion} findSeedTarget={() => null} onHandoff={onHandoff} onEnd={onEnd} />);
  return { ...view, onHandoff, onEnd };
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const caption = () => document.querySelector('.origin-caption')?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  gl.renders = [];
  gl.created = 0;
  gl.disposed = 0;
  gl.lost = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OriginExperience under reduced motion: still frames', () => {
  it('shows one still per step, advanced with Next, drawing each still once and never running a frame loop', () => {
    const { onHandoff, onEnd } = renderOrigin(true);
    expect(screen.getByTestId('origin')).toHaveClass('origin--stills');
    expect(gl.renders).toEqual([STILLS[0]!.t]);

    const seen: string[] = [caption()];
    for (let i = 1; i < STILLS.length; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      seen.push(caption());
    }
    expect(gl.renders).toEqual(STILLS.map(still => still.t));
    expect(seen).toEqual(STILLS.map(still => still.caption ?? ''));
    expect(onHandoff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    advance(450);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('complete');
    // No still was drawn twice and nothing animated between them.
    expect(gl.renders).toHaveLength(STILLS.length);
  });

  it('advances by itself when the reader waits, and still ends in the Universe', () => {
    const { onHandoff, onEnd } = renderOrigin(true);
    for (let i = 1; i < STILLS.length; i++) advance(3400);
    expect(gl.renders).toEqual(STILLS.map(still => still.t));
    expect(caption()).toBe(STILLS[STILLS.length - 1]!.caption);
    advance(3400);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    advance(450);
    expect(onEnd).toHaveBeenCalledWith('complete');
  });

  it('can be skipped from any still', () => {
    const { onHandoff, onEnd } = renderOrigin(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onEnd).toHaveBeenCalledWith('skipped');
    expect(onHandoff).toHaveBeenCalledTimes(1);
    advance(30_000);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('OriginExperience with a renderer: live playback', () => {
  it('plays the timeline, hands off at the handoff time and completes at the end', () => {
    const { onHandoff, onEnd, unmount } = renderOrigin(false);
    expect(screen.getByTestId('origin')).toHaveClass('origin--playing');
    expect(screen.getByRole('button', { name: 'Sound off' })).toHaveAttribute('aria-pressed', 'false');

    advance(22_000);
    expect(caption()).toBe('Your world began before you knew it.');
    expect(onHandoff).not.toHaveBeenCalled();
    advance(Math.ceil((HANDOFF_START - 22) * 1000) + 100);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    advance(Math.ceil((ORIGIN_DURATION - HANDOFF_START) * 1000) + 100);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('complete');
    expect(onHandoff).toHaveBeenCalledTimes(1);
    // Frames were drawn in order and never beyond the end.
    expect(gl.renders.length).toBeGreaterThan(100);
    expect([...gl.renders].sort((a, b) => a - b)).toEqual(gl.renders);
    expect(Math.max(...gl.renders)).toBeLessThan(ORIGIN_DURATION);

    unmount();
    expect(gl.disposed).toBe(1);
  });

  it('a lost GPU context mid-play switches to the CSS version, draws nothing more, and releases the renderer on exit', () => {
    const { onEnd, unmount } = renderOrigin(false);
    advance(5000);
    gl.lost = true;
    advance(100);
    expect(screen.getByTestId('origin')).toHaveClass('origin--fallback');
    const drawn = gl.renders.length;
    advance(900);
    expect(caption()).toBe('Your world began before you knew it.');
    advance(7000);
    expect(onEnd).toHaveBeenCalledWith('failed');
    expect(gl.renders.length).toBe(drawn);
    unmount();
    expect(gl.created).toBe(1);
    expect(gl.disposed).toBe(1);
  });

  it('a sound toggle without an audio device stays off and never blocks the opening', () => {
    const { onEnd } = renderOrigin(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    expect(screen.getByRole('button', { name: 'Sound off' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEnd).toHaveBeenCalledWith('skipped');
  });
});
