import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ReadStop, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { StageReader, type StageReaderHandle } from './stage-reader';

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

/** The page height the reader gives a stop before it has measured its window. */
const PAGE = 320;

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

  it('does not pad a stop in its plainer words to a page, so no blank gap is left under it', async () => {
    await inReader();
    const section = () => screen.getByTestId(`stop-${first.id}`);
    expect(section()).toHaveStyle({ minHeight: PAGE });
    await fireEvent.press(screen.getAllByRole('button', { name: 'Say it simpler' })[0]!);
    expect(section()).not.toHaveStyle({ minHeight: PAGE });
    await fireEvent.press(screen.getByRole('button', { name: 'Undo simpler version' }));
    expect(section()).toHaveStyle({ minHeight: PAGE });
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
