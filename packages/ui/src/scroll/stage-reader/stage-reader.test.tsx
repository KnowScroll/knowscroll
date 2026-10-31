import { fireEvent, render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { ReaderDock } from './reader-chrome';
import { StageReader, type ReaderCommands } from './stage-reader';
import type { StageReadingObserver } from './use-stop-reading';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

/**
 * The reader of a v2 Scroll over the labelled CI fixture (`seasons-stage-ci`, not product content):
 * what is drawn, what a call does on the device and what is reported to the recorder. The browser
 * behaviour (scrolling, snapping, swipes, keys) is in `apps/client/e2e/stage-reader-smoke.spec.ts`.
 */
const document = seasons as unknown as ScrollDocumentV2;

type Spy = { [Method in keyof StageReadingObserver]: jest.Mock<void, Parameters<StageReadingObserver[Method]>> };

function spy(): Spy {
  return {
    onBlockVisibility: jest.fn<void, Parameters<StageReadingObserver['onBlockVisibility']>>(),
    onBlockInteraction: jest.fn<void, Parameters<StageReadingObserver['onBlockInteraction']>>(),
    onActivity: jest.fn<void, Parameters<StageReadingObserver['onActivity']>>(),
  };
}

function reader(observer: StageReadingObserver, commands: ReaderCommands = {}, document_: ScrollDocumentV2 = document) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <StageReader document={document_} observer={observer} commands={commands} />
    </DisplayProvider>,
  );
}

describe('the Stage + Spine reader', () => {
  it('draws the first stop, its picture named by the described state, and a dot for every stop and the end', async () => {
    await reader(spy());
    expect(screen.getByText('It leans.')).toBeOnTheScreen();
    expect(screen.getByLabelText(/The Sun is on the left and Earth is on the right/)).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: /^(Stop|Call it|Final call|The end)/ })).toHaveLength(
      document.stops.length + 1,
    );
    expect(screen.getByRole('button', { name: 'Stop 1 of 12, you are here' })).toBeOnTheScreen();
  });

  it('reports the first stop as the one visible stop, wholly, and nothing else', async () => {
    const observer = spy();
    await reader(observer);
    expect(observer.onBlockVisibility.mock.calls.map(([event]) => [event.blockId, event.visibleFraction])).toEqual([
      ['the-lean', 1],
    ]);
  });

  it('closes the stop it was reading when it goes away', async () => {
    const observer = spy();
    const view = await reader(observer);
    await view.unmount();
    expect(observer.onBlockVisibility.mock.calls.map(([event]) => [event.blockId, event.visibleFraction])).toEqual([
      ['the-lean', 1],
      ['the-lean', 0],
    ]);
  });

  it('plays a call on the device and reports only that the answer was shown, never the option picked', async () => {
    const observer = spy();
    await reader(observer);
    expect(screen.queryByText('Plot twist!')).not.toBeOnTheScreen();
    const lock = screen.getAllByRole('button', { name: 'Lock it in' })[0];
    if (lock === undefined) throw new Error('the first call has a Lock it in button');
    await fireEvent.press(screen.getByRole('radio', { name: /Earth is closer to the Sun in June/ }));
    expect(observer.onBlockInteraction).not.toHaveBeenCalled();
    await fireEvent.press(lock);
    expect(screen.getByText('Plot twist!')).toBeOnTheScreen();
    expect(screen.getByText(/The common guess\. Source: A Private Universe/)).toBeOnTheScreen();
    expect(observer.onBlockInteraction).toHaveBeenCalledTimes(1);
    expect(observer.onBlockInteraction).toHaveBeenCalledWith({
      blockId: 'call-delhi',
      kind: 'revealed',
      at: expect.any(Number) as number,
    });
    // Nothing about the pick can travel: the event has no field for it.
    expect(Object.keys(observer.onBlockInteraction.mock.calls[0]?.[0] as object).sort()).toEqual([
      'at',
      'blockId',
      'kind',
    ]);
    // A second press of the same call reports nothing more.
    await fireEvent.press(lock);
    expect(observer.onBlockInteraction).toHaveBeenCalledTimes(1);
  });

  it('does not lock in a call with nothing picked', async () => {
    const observer = spy();
    await reader(observer);
    const lock = screen.getAllByRole('button', { name: 'Lock it in' })[0];
    if (lock === undefined) throw new Error('the first call has a Lock it in button');
    await fireEvent.press(lock);
    expect(observer.onBlockInteraction).not.toHaveBeenCalled();
    expect(screen.queryByText('Plot twist!')).not.toBeOnTheScreen();
  });

  it('opens an aside from its header and keeps the limits aside as "Small print"', async () => {
    await reader(spy());
    expect(screen.queryByText(/Light sets the season/)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Small print: Where this stops' }));
    expect(screen.getByText(/Light sets the season/)).toBeOnTheScreen();
  });

  it('shows the end tray with its Part 2 peek only when one was admitted, and every way out is a button', async () => {
    const onDone = jest.fn();
    const onPart = jest.fn();
    const onTopic = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <StageReader
          document={document}
          commands={{ nextTopic: onTopic }}
          nextPart={{ label: 'Part 2', title: 'Fixture part two', onPress: onPart }}
          onDone={onDone}
        />
      </DisplayProvider>,
    );
    expect(screen.getByText('Fixture part two')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue Part 2' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Done for today' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Back to the end' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Something new' }));
    expect([onPart, onDone, onTopic].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('has no Part 2 peek and no continue button when no next Part was admitted', async () => {
    await reader(spy());
    expect(screen.queryByRole('button', { name: /^Continue Part/ })).not.toBeOnTheScreen();
  });

  it('says the reader built a picture only when the Scroll has a stage', async () => {
    const withStage = await reader(spy());
    expect(screen.getByText('The picture you built')).toBeOnTheScreen();
    expect(screen.queryByText('The short version')).not.toBeOnTheScreen();
    await withStage.unmount();
    const { stage: _stage, ...plain } = document;
    await reader(spy(), {}, plain);
    expect(screen.queryByText('The picture you built')).not.toBeOnTheScreen();
    expect(screen.getByText('The short version')).toBeOnTheScreen();
  });

  it('offers a related move at the end, named for where it goes, only when one was admitted', async () => {
    await reader(spy());
    expect(screen.queryByRole('button', { name: /^Another related explanation/ })).not.toBeOnTheScreen();
    const onRelated = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <StageReader
          document={document}
          commands={{}}
          related={{ label: 'Related', title: 'Another angle', onPress: onRelated }}
        />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Another related explanation: Another angle' }));
    expect(onRelated).toHaveBeenCalledTimes(1);
  });

  it('names the way on in the dock for where it goes, whether it is the next Part or another angle', async () => {
    const view = await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderDock nextPart={{ label: 'Part 2', title: 'Fixture part two', onPress: jest.fn() }} />
      </DisplayProvider>,
    );
    expect(screen.getByRole('button', { name: 'Part 2: Fixture part two' })).toBeOnTheScreen();
    await view.unmount();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderDock nextPart={{ label: 'Related', title: 'Another angle', related: true, onPress: jest.fn() }} />
      </DisplayProvider>,
    );
    expect(screen.getByRole('button', { name: 'Related: Another angle' })).toBeOnTheScreen();
  });

  it('shows the picture as words in the text version', async () => {
    await reader(spy());
    await fireEvent.press(screen.getByLabelText('Text version'));
    expect(screen.queryByLabelText(/The Sun is on the left/)).not.toBeOnTheScreen();
    expect(screen.getByText(/The Sun is on the left and Earth is on the right/)).toBeOnTheScreen();
  });

  it('reads a Scroll with no stage: no picture, no text switch, the same stops', async () => {
    const { stage: _stage, ...plain } = document;
    await reader(spy(), {}, plain);
    expect(screen.queryByLabelText(/The Sun is on the left/)).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('Text version')).not.toBeOnTheScreen();
    expect(screen.getByText('It leans.')).toBeOnTheScreen();
  });
});
