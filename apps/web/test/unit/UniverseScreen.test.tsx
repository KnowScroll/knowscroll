import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UniverseScreen } from '../../src/components/UniverseScreen.tsx';
import { universeOf } from './fakeApi.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';

const storage = new ReaderStorage(new MemoryStorageBackend());

function loaded(traceCount: number) {
  const traces = Array.from({ length: traceCount }, (_, i) => ({
    eventId: `event-${i}`,
    assetId: `asset-${i}`,
    title: `Kept Scroll ${i}`,
    createdAt: '2026-09-20T10:00:00.000Z',
  }));
  return { status: 'loaded' as const, universe: universeOf({ traces }) };
}

describe('UniverseScreen', () => {
  it('offers a real way into the system level once the universe has bodies to group', () => {
    const onEnterSystem = vi.fn();
    render(
      <UniverseScreen
        state={loaded(3)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={onEnterSystem}
        onRetry={vi.fn()}
      />,
    );

    // A control, not a decorative label. The label read "SYSTEM VIEW" on one surface while
    // doing nothing at all, which claimed a depth that surface could not reach; the level is
    // real now (#116), so the label has to actually go there.
    const control = screen.getByRole('button', { name: 'Open the system view' });
    expect(control).toBeInTheDocument();
    fireEvent.click(control);
    expect(onEnterSystem).toHaveBeenCalledTimes(1);
  });

  it('does not offer the system level before anything has been encountered', () => {
    render(
      <UniverseScreen
        state={loaded(0)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // `GET /v1/worlds` can only return worlds this universe has actually encountered, so on an
    // untouched library there is no system to open and the product does not pretend there is.
    expect(screen.queryByRole('button', { name: 'Open the system view' })).toBeNull();
  });
});
