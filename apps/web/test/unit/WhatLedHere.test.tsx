/**
 * #133 — "What led here" in the desktop reader's "Why this appeared" panel: parity with Android's
 * `WhySection` (apps/mobile/.../ui/scroll/ScrollScreen.kt). Only what the recorded explanation
 * carries is shown -- the family that chose the encounter and its evidence path, one line per
 * recorded step -- and only the corrections it supports and the reader has not already made, each
 * saying what it does before and after it is pressed. The panel takes focus when opened and hands
 * it back to its trigger when Escape closes it.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScrollScreen, type ScrollScreenProps } from '../../src/components/ScrollScreen.tsx';
import type { ScrollView, WhyView } from '../../src/state/readerStore.ts';
import { feedItem, whyOf } from './fakeApi.ts';

type OpenWhy = Extract<WhyView, { status: 'open' }>;

function readingState(overrides: Partial<Extract<ScrollView, { status: 'reading' }>> = {}): ScrollView {
  return {
    status: 'reading',
    item: feedItem(),
    exposureId: 'exp-1',
    eventId: 'evt-1',
    keep: { status: 'idle' },
    readingPosition: 0,
    discovery: 'idle',
    origin: { type: 'discovery' },
    ...overrides,
  };
}

function openView(overrides: Partial<OpenWhy> = {}): OpenWhy {
  return {
    status: 'open',
    decisionId: whyOf().decisionId,
    assetId: feedItem().assetId,
    availability: { status: 'loaded', why: whyOf() },
    sending: null,
    corrected: [],
    notice: null,
    ...overrides,
  };
}

function renderReader(props: Partial<ScrollScreenProps> = {}) {
  const handlers = {
    onOpenWhy: vi.fn(),
    onCloseWhy: vi.fn(),
    onRetryWhy: vi.fn(),
    onCorrect: vi.fn(),
    onReturn: vi.fn(),
  };
  const view = render(
    <ScrollScreen
      state={readingState()}
      onVisible={vi.fn()}
      onKeep={vi.fn()}
      onNext={vi.fn()}
      onRetry={vi.fn()}
      onReadingPosition={vi.fn()}
      why={openView()}
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Why this appeared' }));
  return screen.getByRole('region', { name: 'Why this appeared' });
}

describe('What led here (#133)', () => {
  it('opening the panel asks the store for this encounter and moves focus into the panel', () => {
    const { onOpenWhy } = renderReader({ why: { status: 'closed' } });
    const panel = openPanel();
    expect(onOpenWhy).toHaveBeenCalledTimes(1);
    expect(panel).toHaveFocus();
  });

  it('Escape closes it, tells the store, and hands focus back to its trigger (not back to the Universe)', () => {
    const { onCloseWhy, onReturn } = renderReader();
    openPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseWhy).toHaveBeenCalledTimes(1);
    expect(onReturn).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Why this appeared' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Why this appeared' })).toHaveFocus();
  });

  it('the trigger toggles it closed, and opening the sources closes it too', () => {
    const { onCloseWhy } = renderReader();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Why this appeared' }));
    expect(onCloseWhy).toHaveBeenCalledTimes(1);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /Open sources panel/ }));
    expect(onCloseWhy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('region', { name: 'Why this appeared' })).not.toBeInTheDocument();
  });

  it('shows the recorded route and one line per recorded step, under its own heading', () => {
    renderReader();
    const panel = openPanel();
    expect(within(panel).getByRole('heading', { level: 3, name: 'What led here' })).toBeInTheDocument();
    expect(within(panel).getByText('bridge')).toBeInTheDocument();
    expect(within(panel).getByText(/cross a sourced connection/)).toBeInTheDocument();
    const steps = within(within(panel).getByRole('list', { name: 'Recorded path' })).getAllByRole('listitem');
    expect(steps.map(step => step.textContent)).toEqual(['You kept “A rhythm the ocean keeps”', 'Tides is explained by Gravity']);
  });

  it('says every recorded step kind in words, from recorded fields only', () => {
    const why = whyOf({
      family: 'continue',
      evidence: [
        { kind: 'mark', markKind: 'branch', assetId: 'a1', title: 'Moons', at: '2026-09-24T10:00:00.000Z', eventId: 'e1' },
        { kind: 'mark', markKind: 'ask', assetId: 'a2', title: 'Tides', at: '2026-09-24T10:00:00.000Z', eventId: 'e2' },
        { kind: 'question', concept: 'physics.gravity' },
        { kind: 'outside', domain: 'life' },
      ],
      corrections: ['less_like_this'],
    });
    renderReader({ why: openView({ availability: { status: 'loaded', why } }) });
    openPanel();
    const steps = within(screen.getByRole('list', { name: 'Recorded path' })).getAllByRole('listitem');
    expect(steps.map(step => step.textContent)).toEqual([
      'You followed a connection from “Moons”',
      'You asked about “Tides”',
      'A question you asked that has no answer yet',
      'Somewhere you have not been shown before',
    ]);
  });

  it('offers each supported correction as a labelled button that says what it will do', () => {
    const { onCorrect } = renderReader();
    openPanel();
    const less = screen.getByRole('button', { name: 'Less like this' });
    const wrong = screen.getByRole('button', { name: 'Wrong connection' });
    expect(less).toHaveAccessibleDescription(/less of this route for 14 days.*Nothing shared changes/);
    expect(wrong).toHaveAccessibleDescription(/Hides this connection for you.*sources stay unchanged/);
    fireEvent.click(less);
    expect(onCorrect).toHaveBeenCalledWith('less_like_this');
  });

  it('a correction already made is not offered again, and none can be pressed while one is being sent', () => {
    const { rerender, onCorrect } = renderReader({ why: openView({ sending: 'less_like_this' }) });
    openPanel();
    // aria-disabled, never disabled: a disabled button would drop keyboard focus to <body> when a
    // correction then fails (review M2), so they stay focusable and simply ignore presses.
    for (const name of ['Less like this', 'Wrong connection']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
      button.focus();
      fireEvent.click(button);
      expect(document.activeElement).toBe(button);
    }
    expect(onCorrect).not.toHaveBeenCalled();
    rerender(
      <ScrollScreen
        state={readingState()}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={vi.fn()}
        onReturn={vi.fn()}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
        why={openView({ corrected: ['less_like_this'], notice: { kind: 'corrected', correction: 'less_like_this' } })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Less like this' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wrong connection' })).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('You will see less of this route for 14 days. Nothing shared changed.');
  });

  it('when the pressed correction disappears (recorded), keyboard focus lands on its confirmation, not on <body>', () => {
    const { rerender } = renderReader();
    openPanel();
    screen.getByRole('button', { name: 'Less like this' }).focus();
    rerender(
      <ScrollScreen
        state={readingState()}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={vi.fn()}
        onReturn={vi.fn()}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
        why={openView({ corrected: ['less_like_this'], notice: { kind: 'corrected', correction: 'less_like_this' } })}
      />,
    );
    expect(screen.getByRole('status')).toHaveFocus();
  });

  it('confirms "wrong connection" in its own words', () => {
    renderReader({ why: openView({ corrected: ['wrong_connection'], notice: { kind: 'corrected', correction: 'wrong_connection' } }) });
    openPanel();
    expect(screen.getByRole('status')).toHaveTextContent('This connection is hidden for you. The sources are unchanged.');
    expect(screen.queryByRole('button', { name: 'Wrong connection' })).not.toBeInTheDocument();
  });

  it('a failed correction is said as a failure, honestly (it may or may not have landed; the retry is the same act)', () => {
    renderReader({
      why: openView({ notice: { kind: 'failed', correction: 'less_like_this', message: 'Connection interrupted. Please retry; your action keeps the same identity.' } }),
    });
    openPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('“Less like this” could not be confirmed. Connection interrupted. Please retry; your action keeps the same identity.');
    expect(screen.getByRole('button', { name: 'Less like this' })).toBeEnabled();
  });

  it('an encounter with no route to correct says so', () => {
    renderReader({ why: openView({ notice: { kind: 'no-route' } }) });
    openPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('This encounter has no route that can be corrected.');
  });

  it('an unmapped (fallback) encounter shows its honest empty path and offers nothing to correct', () => {
    const why = whyOf({ family: 'fallback', evidence: [], corrections: [], corrected: [] });
    renderReader({ why: openView({ availability: { status: 'loaded', why } }) });
    const panel = openPanel();
    expect(within(panel).getByText('Nothing you did led here; it was offered so nothing in the library stays hidden.')).toBeInTheDocument();
    expect(within(panel).queryByRole('list', { name: 'Recorded path' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('group', { name: 'Correct this route' })).not.toBeInTheDocument();
  });

  it('loading, unrecorded and failed each say what is true, and a failed read can be retried', () => {
    const { rerender, onRetryWhy } = renderReader({ why: openView({ availability: { status: 'loading' } }) });
    openPanel();
    expect(screen.getByText('Reading what was recorded…')).toBeInTheDocument();
    const rerenderWith = (why: WhyView) =>
      rerender(
        <ScrollScreen
          state={readingState()}
          onVisible={vi.fn()}
          onKeep={vi.fn()}
          onNext={vi.fn()}
          onReturn={vi.fn()}
          onRetry={vi.fn()}
          onReadingPosition={vi.fn()}
          why={why}
          onRetryWhy={onRetryWhy}
        />,
      );
    rerenderWith(openView({ availability: { status: 'unrecorded' } }));
    expect(screen.getByText('This step was not chosen by the Composer, so there is no recorded path to show.')).toBeInTheDocument();
    rerenderWith(openView({ availability: { status: 'failed', message: 'Connection interrupted.' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('The recorded path could not be read. Connection interrupted.');
    // The accessible name starts with the visible text, so "click Try again" works (review M5).
    fireEvent.click(screen.getByRole('button', { name: /^Try again/ }));
    expect(onRetryWhy).toHaveBeenCalledTimes(1);
  });

  it('never shows an explanation recorded for a different Scroll', () => {
    renderReader({ why: openView({ assetId: '99999999-0000-4000-8000-000000000000' }) });
    const panel = openPanel();
    expect(within(panel).queryByRole('heading', { name: 'What led here' })).not.toBeInTheDocument();
  });

  it('without a store attached (no why prop) the panel is exactly what it was', () => {
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
    const panel = openPanel();
    expect(within(panel).queryByRole('heading', { name: 'What led here' })).not.toBeInTheDocument();
  });
});
