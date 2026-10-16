import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UniverseScreen } from '../../src/components/UniverseScreen.tsx';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { universeOf } from './fakeApi.ts';
import { ids, twoStarSky } from './skyFixture.ts';

const storage = new ReaderStorage(new MemoryStorageBackend());
const loaded = { status: 'loaded' as const, universe: universeOf({ traces: [] }) };

function renderUniverse(onEnterScroll = vi.fn()) {
  const view = render(<UniverseScreen state={loaded} storage={storage} onEnterScroll={onEnterScroll} onOpenTrace={vi.fn()} onEnterSystem={vi.fn()} onOpenPrivacy={vi.fn()} onRetry={vi.fn()} />);
  return { ...view, onEnterScroll };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Universe spatial navigation', () => {
  it('pans with visible controls and keyboard, and recenters', () => {
    renderUniverse();
    const map = screen.getByLabelText(/Explore the starfield/);
    fireEvent.click(screen.getByRole('button', { name: 'Pan left' }));
    expect(map.querySelector('.universe-bodies')).toHaveStyle({ transform: 'translate3d(70px, 0px, 0) scale(1)' });
    fireEvent.keyDown(map, { key: 'ArrowDown' });
    expect(map.querySelector('.universe-bodies')).toHaveStyle({ transform: 'translate3d(70px, -60px, 0) scale(1)' });
    fireEvent.click(screen.getByRole('button', { name: 'Recenter the universe' }));
    expect(map.querySelector('.universe-bodies')).toHaveStyle({ transform: 'translate3d(0px, 0px, 0) scale(1)' });
  });

  it('does not activate a planet when the pointer gesture panned the map', () => {
    const { onEnterScroll } = renderUniverse();
    const map = screen.getByLabelText(/Explore the starfield/);
    fireEvent.pointerDown(map, { pointerId: 1, button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 90, clientY: 75 });
    fireEvent.pointerUp(map, { pointerId: 1, button: 0, clientX: 90, clientY: 75 });
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }), { detail: 1 });
    expect(onEnterScroll).not.toHaveBeenCalled();
  });

  it('flies the ship to the first possibility, then opens a Scroll; under reduced motion it opens at once', () => {
    vi.useFakeTimers();
    const { onEnterScroll, rerender } = renderUniverse();
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    expect(screen.getByRole('status', { name: 'Travelling to your destination' })).toBeInTheDocument();
    expect(onEnterScroll).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1050); });
    // The seed is a way into reading, not a world: no landing comes between the trip and the Scroll.
    expect(screen.queryByRole('region', { name: 'Planet landing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Travelling to your destination' })).not.toBeInTheDocument();
    expect(onEnterScroll).toHaveBeenCalledTimes(1);

    rerender(<UniverseScreen state={loaded} storage={storage} reducedMotion onEnterScroll={onEnterScroll} onOpenTrace={vi.fn()} onEnterSystem={vi.fn()} onOpenPrivacy={vi.fn()} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    expect(screen.queryByRole('status', { name: 'Travelling to your destination' })).not.toBeInTheDocument();
    expect(onEnterScroll).toHaveBeenCalledTimes(2);
  });

  it('flies the ship to a kept light, then reopens the saved Trace directly (a Trace is not a world)', () => {
    vi.useFakeTimers();
    const trace = { eventId: 'trace-1', assetId: 'asset-1', title: 'A rhythm the ocean keeps', createdAt: '2026-09-30T10:00:00Z' };
    const onOpenTrace = vi.fn();
    render(<UniverseScreen state={{ status: 'loaded', universe: universeOf({ traces: [trace] }) }} storage={storage} onEnterScroll={vi.fn()} onOpenTrace={onOpenTrace} onEnterSystem={vi.fn()} onOpenPrivacy={vi.fn()} onRetry={vi.fn()} />);
    const kept = within(screen.getByRole('navigation', { name: 'Saved Traces' })).getByRole('button', { name: 'Revisit the saved Trace: A rhythm the ocean keeps' });
    fireEvent.click(kept);
    expect(screen.getByRole('status', { name: 'Travelling to your destination' })).toBeInTheDocument();
    expect(onOpenTrace).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1050); });
    expect(screen.queryByRole('region', { name: 'Planet landing' })).not.toBeInTheDocument();
    expect(onOpenTrace).toHaveBeenCalledTimes(1);
    expect(onOpenTrace).toHaveBeenCalledWith(trace);
  });

  it('lets the reader turn a landed world and change its light without reading from it', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const onReadFrom = vi.fn();
    const onEnterScroll = vi.fn();
    render(<UniverseScreen state={loaded} sky={{ status: 'loaded', response: twoStarSky(), settingAside: null, error: null }} storage={storage} onEnterScroll={onEnterScroll} onReadFrom={onReadFrom} onOpenTrace={vi.fn()} onEnterSystem={vi.fn()} onOpenPrivacy={vi.fn()} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Gravity: / }));
    fireEvent.click(screen.getByRole('button', { name: 'Land on Orbits, a world inside Gravity' }));
    expect(screen.getByRole('region', { name: 'Planet landing' }).querySelector('.world-globe')).toBeInTheDocument();
    const planet = screen.getByRole('button', { name: /Rotate planet Orbits/ });
    expect(screen.getByText('Daylight')).toBeInTheDocument();

    fireEvent.pointerDown(planet, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(planet, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(planet, { pointerId: 1, clientX: 160 });
    fireEvent.click(planet);
    expect(planet.style.getPropertyValue('--surface-shift')).not.toBe('0px');
    expect(screen.getByText('Daylight')).toBeInTheDocument();

    fireEvent.click(planet);
    expect(screen.getByText('Evening glow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Advance the moon/ }));
    expect(screen.getByText('Moonlit')).toBeInTheDocument();
    const before = planet.style.getPropertyValue('--surface-shift');
    fireEvent.keyDown(planet, { key: 'ArrowLeft' });
    expect(planet.style.getPropertyValue('--surface-shift')).not.toBe(before);
    expect(onReadFrom).not.toHaveBeenCalled();
    expect(onEnterScroll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Read from Orbits' }));
    expect(onReadFrom).toHaveBeenCalledTimes(1);
    expect(onReadFrom).toHaveBeenCalledWith(ids.orbits, 'Orbits');
  });

  it('cancels an in-flight trip on privacy navigation and unmount', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    const onOpenPrivacy = vi.fn();
    const onEnterScroll = vi.fn();
    const view = render(<UniverseScreen state={loaded} storage={storage} onEnterScroll={onEnterScroll} onOpenTrace={vi.fn()} onEnterSystem={vi.fn()} onOpenPrivacy={onOpenPrivacy} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open privacy controls' }));
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(onEnterScroll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    view.unmount();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(onEnterScroll).not.toHaveBeenCalled();
  });
});
