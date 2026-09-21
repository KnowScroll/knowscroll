import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SystemScreen } from '../../src/components/SystemScreen.tsx';
import type { SystemView } from '../../src/state/readerStore.ts';
import { worldSystemOf } from './fakeApi.ts';

describe('SystemScreen', () => {
  it('renders exactly the worlds GET /v1/worlds returned, with their real counts', () => {
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} onEnterScroll={vi.fn()} />);

    // Every world's real sourceTitle appears, and no other body was invented.
    expect(screen.getByText("NASA · Orbits and Kepler's Laws")).toBeInTheDocument();
    expect(screen.getByText('NASA · Stars')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    // Real per-world counts, not dressed up.
    expect(screen.getByText('2 of 9 Scrolls encountered')).toBeInTheDocument();
    expect(screen.getByText('8 of 8 Scrolls encountered')).toBeInTheDocument();

    // The subtitle states only the real number of worlds and Scrolls.
    expect(screen.getByText('2 worlds, connected by your exploration.')).toBeInTheDocument();
  });

  it('opens a local world and closes it before leaving the system', () => {
    const onReturn = vi.fn();
    render(<SystemScreen state={{ status: 'loaded', response: worldSystemOf() }} onReturn={onReturn} onRetry={vi.fn()} onEnterScroll={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore world: NASA · Stars' }));
    expect(screen.getByRole('heading', { name: 'NASA · Stars' })).toHaveFocus();
    expect(screen.getByText(/All currently available Scrolls/)).toBeInTheDocument();
    expect(screen.queryByText('FULLY EXPLORED')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onReturn).not.toHaveBeenCalled();
    expect(screen.getByRole('list', { name: 'Worlds in your system' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('links each world to its real source, opening in a new tab', () => {
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} onEnterScroll={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Explore world: NASA · Stars' }));
    const link = screen.getByRole('link', { name: /Open source: NASA · Stars/ });
    expect(link).toHaveAttribute('href', 'https://example.com/stars');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the honest empty state when the API returns no system, inventing nothing', () => {
    const response = worldSystemOf({ system: null });
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} onEnterScroll={vi.fn()} />);

    expect(screen.getByText('Your first world is waiting.')).toBeInTheDocument();
    expect(screen.getByText(/Read a Scroll and its source/)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('shows an unavailable state with a working Retry', () => {
    const onRetry = vi.fn();
    const state: SystemView = { status: 'unavailable', message: 'Connection interrupted.' };
    render(<SystemScreen state={state} onReturn={vi.fn()} onRetry={onRetry} onEnterScroll={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Your system is unavailable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('carries the dock, the frame every level shares, marking Atlas as the containing destination', () => {
    const onEnterScroll = vi.fn();
    const onReturn = vi.fn();
    render(
      <SystemScreen state={{ status: 'loaded', response: worldSystemOf() }} onReturn={onReturn} onRetry={vi.fn()} onEnterScroll={onEnterScroll} />,
    );

    const dock = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(dock).toBeInTheDocument();
    // System is not one of the dock's three destinations, so marking one current would tell the
    // reader they are somewhere they are not.
    expect(screen.getByRole('button', { name: 'Atlas — your universe' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Cable — read a Scroll' }));
    expect(onEnterScroll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Atlas — your universe' }));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('returns to Universe on Escape and Home, and via the back pill', () => {
    const onReturn = vi.fn();
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={onReturn} onRetry={vi.fn()} onEnterScroll={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Return to Universe' }));
    expect(onReturn).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Home' });
    expect(onReturn).toHaveBeenCalledTimes(3);
  });
});
