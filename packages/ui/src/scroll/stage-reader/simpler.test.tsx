import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ReadStop, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { quickAnswerFor } from './quick-answer';
import { StageReader, type StageReaderHandle } from './stage-reader';
import { ReadStopView } from './stop-view';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

/** The labelled CI fixture (`seasons-stage-ci`), never product content. */
const document = seasons as unknown as ScrollDocumentV2;
const first = document.stops[0] as ReadStop;

function inReader(handle?: React.Ref<StageReaderHandle>) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <StageReader document={document} commands={{}} handleRef={handle} />
    </DisplayProvider>,
  );
}

describe('Simpler, in place with Undo (V3 D2)', () => {
  it('swaps the stop for its own plainer words, names them, and puts the full text back on Undo', async () => {
    await inReader();
    expect(screen.getByText('It leans.')).toBeOnTheScreen();
    await fireEvent.press(screen.getAllByRole('button', { name: 'Say it simpler' })[0]!);
    expect(screen.getByText(first.simple)).toBeOnTheScreen();
    expect(screen.queryByText('It leans.')).not.toBeOnTheScreen();
    expect(screen.getByText('SIMPLER VERSION')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Undo simpler version' }));
    expect(screen.getByText('It leans.')).toBeOnTheScreen();
    expect(screen.queryByText('SIMPLER VERSION')).not.toBeOnTheScreen();
  });

  it('is switched by the ••• menu through the reader, for the stop on screen only', async () => {
    const handle = createRef<StageReaderHandle>();
    await inReader(handle);
    await act(() => {
      expect(handle.current?.toggleSimpler()).toBe(true);
    });
    expect(screen.getByText(first.simple)).toBeOnTheScreen();
    // Only that stop changed: the second stop still reads in full.
    expect(screen.getAllByRole('button', { name: 'Say it simpler' }).length).toBe(
      document.stops.filter((s) => s.kind === 'read').length - 1,
    );
  });
});

describe('a Quick answer on a stop (V3 D2, D-244)', () => {
  const quick = quickAnswerFor(document, 'steeper-light', 'steeper')!;
  const stop = document.stops.find((candidate) => candidate.id === 'steeper-light') as ReadStop;

  it('says what it is, shows the Scroll’s own words and offers a full Scroll, a follow-up and a report', async () => {
    const actions = { onClose: jest.fn(), onMakeScroll: jest.fn(), onFollowUp: jest.fn(), onReport: jest.fn() };
    await render(
      <ReadStopView stop={stop} simpler={false} onToggleSimpler={jest.fn()} quick={quick} quickActions={actions} />,
    );
    expect(screen.getByText('QUICK ANSWER · FROM THIS SCROLL')).toBeOnTheScreen();
    expect(screen.getByText('About “steeper”')).toBeOnTheScreen();
    expect(screen.getByText(stop.simple)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Make it a full Scroll' }));
    expect(actions.onMakeScroll).toHaveBeenCalledWith('steeper');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask a follow-up' }));
    expect(actions.onFollowUp).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Report' }));
    expect(actions.onReport).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Close the quick answer' }));
    expect(actions.onClose).toHaveBeenCalled();
  });

  it('leaves out Ask and Report where the screen offers neither', async () => {
    await render(
      <ReadStopView
        stop={stop}
        simpler={false}
        onToggleSimpler={jest.fn()}
        quick={quick}
        quickActions={{ onClose: jest.fn() }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Make it a full Scroll' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Report' })).not.toBeOnTheScreen();
  });

  it('is not drawn under a stop it is not about', async () => {
    await render(
      <ReadStopView
        stop={document.stops[0] as ReadStop}
        simpler={false}
        onToggleSimpler={jest.fn()}
        quick={undefined}
        quickActions={{ onClose: jest.fn() }}
      />,
    );
    expect(screen.queryByText('QUICK ANSWER · FROM THIS SCROLL')).not.toBeOnTheScreen();
  });
});
