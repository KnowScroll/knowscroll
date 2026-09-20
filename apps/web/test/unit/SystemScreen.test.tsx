import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SystemScreen } from '../../src/components/SystemScreen.tsx';
import type { SystemView } from '../../src/state/readerStore.ts';
import { worldSystemOf } from './fakeApi.ts';

describe('SystemScreen', () => {
  it('renders exactly the worlds GET /v1/worlds returned, with their real counts', () => {
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} />);

    // Every world's real sourceTitle appears, and no other body was invented.
    expect(screen.getByText("NASA · Orbits and Kepler's Laws")).toBeInTheDocument();
    expect(screen.getByText('NASA · Stars')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    // Real per-world counts, not dressed up.
    expect(screen.getByText('9 SCROLLS · 2 SEEN')).toBeInTheDocument();
    expect(screen.getByText('8 SCROLLS · 8 SEEN')).toBeInTheDocument();

    // The subtitle states only the real number of worlds and Scrolls.
    expect(screen.getByText('2 WORLDS · 17 SCROLLS RECORDED · 10 SEEN')).toBeInTheDocument();
  });

  it('gives a fully explored world and a partially explored world visibly distinct treatment', () => {
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByText('MORE TO EXPLORE')).toBeInTheDocument();
    expect(screen.getByText('FULLY EXPLORED')).toBeInTheDocument();
  });

  it('links each world to its real source, opening in a new tab', () => {
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} />);

    const link = screen.getByRole('link', { name: /Open source: NASA · Stars/ });
    expect(link).toHaveAttribute('href', 'https://example.com/stars');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the honest empty state when the API returns no system, inventing nothing', () => {
    const response = worldSystemOf({ system: null });
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByText('Nothing has been encountered yet')).toBeInTheDocument();
    expect(screen.getByText(/There is no system yet because nothing has been encountered/)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('shows an unavailable state with a working Retry', () => {
    const onRetry = vi.fn();
    const state: SystemView = { status: 'unavailable', message: 'Connection interrupted.' };
    render(<SystemScreen state={state} onReturn={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByRole('heading', { name: 'The system is unavailable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading the system' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('returns to Universe on Escape and Home, and via the back pill', () => {
    const onReturn = vi.fn();
    const response = worldSystemOf();
    render(<SystemScreen state={{ status: 'loaded', response }} onReturn={onReturn} onRetry={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Return to Universe' }));
    expect(onReturn).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Home' });
    expect(onReturn).toHaveBeenCalledTimes(3);
  });
});
