import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UniverseScreen } from '../../src/components/UniverseScreen.tsx';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { universeOf } from './fakeApi.ts';

const storage = new ReaderStorage(new MemoryStorageBackend());
const loaded = { status: 'loaded' as const, universe: universeOf({ traces: [] }) };

function renderUniverse(onEnterScroll = vi.fn()) {
  const view = render(<UniverseScreen state={loaded} storage={storage} onEnterScroll={onEnterScroll} onOpenTrace={vi.fn()} onEnterSystem={vi.fn()} onOpenPrivacy={vi.fn()} onRetry={vi.fn()} />);
  return { ...view, onEnterScroll };
}

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

  it('shows ship travel, then a visible surface before opening the Scroll', () => {
    vi.useFakeTimers();
    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal('matchMedia', matchMedia);
    const { onEnterScroll } = renderUniverse();
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    expect(screen.getByRole('status', { name: 'Travelling to your destination' })).toBeInTheDocument();
    expect(onEnterScroll).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1050); });
    expect(screen.getByRole('region', { name: 'Planet landing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rotate planet A first possibility/ })).toBeInTheDocument();
    expect(onEnterScroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discover a Scroll' }));
    expect(onEnterScroll).toHaveBeenCalledTimes(1);

    matchMedia.mockReturnValue({ matches: true });
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    expect(screen.getByRole('region', { name: 'Planet landing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discover a Scroll' }));
    expect(onEnterScroll).toHaveBeenCalledTimes(2);
  });

  it('lands on visible continents before reopening a saved Trace', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    const trace = { eventId: 'trace-1', assetId: 'asset-1', title: 'A rhythm the ocean keeps', createdAt: '2026-09-30T10:00:00Z' };
    const onOpenTrace = vi.fn();
    render(<UniverseScreen state={{ status: 'loaded', universe: universeOf({ traces: [trace] }) }} storage={storage} onEnterScroll={vi.fn()} onOpenTrace={onOpenTrace} onEnterSystem={vi.fn()} onOpenPrivacy={vi.fn()} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Revisit the saved Trace/ }));
    act(() => { vi.advanceTimersByTime(1050); });
    expect(screen.getByRole('region', { name: 'Planet landing' }).querySelector('.world-globe')).toBeInTheDocument();
    expect(onOpenTrace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open saved Scroll' }));
    expect(onOpenTrace).toHaveBeenCalledWith(trace);
  });

  it('lets the reader turn the landed planet and change its light without opening the Scroll', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const { onEnterScroll } = renderUniverse();
    fireEvent.click(screen.getByRole('button', { name: /A first possibility/ }));
    const planet = screen.getByRole('button', { name: /Rotate planet A first possibility/ });
    expect(screen.getByText('Daylight')).toBeInTheDocument();

    fireEvent.pointerDown(planet, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(planet, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(planet, { pointerId: 1, clientX: 160 });
    fireEvent.click(planet);
    expect(planet.style.getPropertyValue('--surface-shift')).not.toBe('0px');
    expect(screen.getByText('Daylight')).toBeInTheDocument();
    expect(onEnterScroll).not.toHaveBeenCalled();

    fireEvent.click(planet);
    expect(screen.getByText('Evening glow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Advance the moon/ }));
    expect(screen.getByText('Moonlit')).toBeInTheDocument();
    fireEvent.keyDown(planet, { key: 'ArrowLeft' });
    expect(onEnterScroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discover a Scroll' }));
    expect(onEnterScroll).toHaveBeenCalledTimes(1);
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
