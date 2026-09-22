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
        onOpenPrivacy={vi.fn()}
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

  it('offers system inspection even when no Traces have been kept', () => {
    render(
      <UniverseScreen
        state={loaded(0)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onOpenPrivacy={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // No Keep does not imply no encounters. The API, not this collection count, owns the empty system.
    expect(screen.getByRole('button', { name: 'Open the system view' })).toBeInTheDocument();
  });

  it('offers a real way into the privacy panel regardless of whether anything has been kept (#119)', () => {
    const onOpenPrivacy = vi.fn();
    const { rerender } = render(
      <UniverseScreen
        state={loaded(0)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onOpenPrivacy={onOpenPrivacy}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open privacy controls' }));
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1);

    rerender(
      <UniverseScreen
        state={loaded(3)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onOpenPrivacy={onOpenPrivacy}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open privacy controls' })).toBeInTheDocument();
  });
});
