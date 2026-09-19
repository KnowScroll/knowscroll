import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScrollScreen } from '../../src/components/ScrollScreen.tsx';
import type { ScrollView } from '../../src/state/readerStore.ts';
import { feedItem } from './fakeApi.ts';

function readingState(overrides: Partial<Extract<ScrollView, { status: 'reading' }>> = {}): ScrollView {
  return {
    status: 'reading',
    item: feedItem(),
    exposureId: '',
    eventId: 'evt-1',
    keep: { status: 'idle' },
    readingPosition: 0,
    discovery: 'idle',
    origin: { type: 'discovery' },
    ...overrides,
  };
}

describe('ScrollScreen', () => {
  it('shows the truth state, its meaning, and the blank-reason fallback for the Why panel', () => {
    render(
      <ScrollScreen
        state={readingState({ item: feedItem({ reason: '' }) })}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={vi.fn()}
        onReturn={vi.fn()}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
      />,
    );
    expect(screen.getByText(/DOCUMENTED/)).toBeInTheDocument();
    expect(screen.getByText(/Directly supported by strong cited evidence/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Why this appeared' }));
    expect(screen.getByText('No explanation recorded.')).toBeInTheDocument();
  });

  it('opens the source rail via the Sources button with an accessible new-tab link', () => {
    render(
      <ScrollScreen
        state={readingState()}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={vi.fn()}
        onReturn={vi.fn()}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Open sources panel/ }));
    const link = screen.getByRole('link', { name: /Open source/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('href', feedItem().sourceUrl);
  });

  it('disables Keep while saving and shows Kept once accepted', () => {
    const { rerender } = render(
      <ScrollScreen
        state={readingState({ keep: { status: 'saving' } })}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={vi.fn()}
        onReturn={vi.fn()}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Keeping…' })).toBeDisabled();

    rerender(
      <ScrollScreen
        state={readingState({ keep: { status: 'kept', jobId: 'job-1' } })}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={vi.fn()}
        onReturn={vi.fn()}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Kept' })).toBeDisabled();
  });

  it('never binds ArrowRight to any action and Escape/Home returns to Universe when the rail is closed', () => {
    const onReturn = vi.fn();
    const onNext = vi.fn();
    render(
      <ScrollScreen
        state={readingState()}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={onNext}
        onReturn={onReturn}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onReturn).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
