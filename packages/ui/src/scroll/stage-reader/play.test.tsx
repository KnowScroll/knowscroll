import { fireEvent, render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { keepingNote } from './call-state';
import { ReaderDock } from './reader-chrome';
import type { StageLock, StagePlay } from './stage-play';
import { StageReader } from './stage-reader';
import type { StageReadingObserver } from './use-stop-reading';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
// The first render of the whole reader compiles the stage and every stop; on a busy machine that outlasts five seconds.
jest.setTimeout(20_000);

/**
 * Play on the reader (D-063, D-064, D-083) over the labelled CI fixture `seasons-stage-ci` (not
 * product content): what a locked Call it shows, what is handed to the play layer, and what the
 * reader still reports to the recorder, which is the reveal by kind and never the option.
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

/** A play layer the test holds: what is locked, and a record of every lock the reader asks for. */
function playing(locks: readonly StageLock[] = [], paused = false) {
  const asked = jest.fn<void, [string, number]>();
  const play: StagePlay = {
    locks,
    sparks: locks.filter((lock) => lock.correct).length,
    combo: locks.at(-1)?.combo ?? 0,
    paused,
    lock: asked,
  };
  return { play, asked };
}

function reader(play?: StagePlay, observer: StageReadingObserver = spy()) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <StageReader document={document} observer={observer} commands={{}} play={play} />
    </DisplayProvider>,
  );
}

const lockedCall = (over: Partial<StageLock> = {}): StageLock => ({
  stopId: 'call-delhi',
  option: 1,
  correct: true,
  combo: 1,
  keeping: 'saved',
  ...over,
});

const firstLock = () => {
  const lock = screen.getAllByRole('button', { name: 'Lock it in' })[0];
  if (lock === undefined) throw new Error('the first call has a Lock it in button');
  return lock;
};

describe('play on the reader', () => {
  it('hands a locked Call it to the play layer with the option, and reports only the reveal to the recorder', async () => {
    const observer = spy();
    const { play, asked } = playing();
    await reader(play, observer);
    await fireEvent.press(screen.getByRole('radio', { name: /Delhi’s half of Earth leans toward the Sun/ }));
    expect(asked).not.toHaveBeenCalled();
    await fireEvent.press(firstLock());
    expect(asked).toHaveBeenCalledWith('call-delhi', 1);
    expect(observer.onBlockInteraction).toHaveBeenCalledTimes(1);
    expect(Object.keys(observer.onBlockInteraction.mock.calls[0]?.[0] as object).sort()).toEqual([
      'at',
      'blockId',
      'kind',
    ]);
  });

  it('shows "Called it!", the spark and the combo for a right call that play holds', async () => {
    await reader(playing([lockedCall({ combo: 2 })]).play);
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
    expect(screen.getByText('+1 spark')).toBeOnTheScreen();
    expect(screen.getByText('Combo ×2')).toBeOnTheScreen();
    expect(screen.queryByText('Plot twist!')).not.toBeOnTheScreen();
  });

  it('shows no combo for a first right call', async () => {
    await reader(playing([lockedCall()]).play);
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
    expect(screen.queryByText(/^Combo/)).not.toBeOnTheScreen();
  });

  it('shows the Plot twist with what was called and the sourced common guess, and no spark', async () => {
    await reader(playing([lockedCall({ option: 0, correct: false, combo: 0 })]).play);
    expect(screen.getByText('Plot twist!')).toBeOnTheScreen();
    expect(screen.getByText('You called: Earth is closer to the Sun in June')).toBeOnTheScreen();
    expect(screen.getByText("You're in good company")).toBeOnTheScreen();
    expect(screen.getByText(/The common guess\. Source: A Private Universe/)).toBeOnTheScreen();
    expect(screen.queryByText('+1 spark')).not.toBeOnTheScreen();
    expect(screen.queryByText('Called it!')).not.toBeOnTheScreen();
  });

  it('shows a call play holds as already revealed, as after a reload, and reports nothing for it', async () => {
    const observer = spy();
    await reader(playing([lockedCall()]).play, observer);
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
    expect(observer.onBlockInteraction).not.toHaveBeenCalled();
  });

  it('says nothing is saved while recording is paused, before and after the lock', async () => {
    // Each open Call it says so before the lock (the Final call stays on the device and says nothing) ...
    const view = await reader(playing([], true).play);
    expect(screen.getAllByText('Not saved while recording is paused.')).toHaveLength(2);
    await view.unmount();
    // ... and the one that was locked says it in its reveal, in place of the line before the lock.
    await reader(playing([lockedCall({ keeping: 'recording_paused' })], true).play);
    expect(screen.getAllByText('Not saved while recording is paused.')).toHaveLength(2);
    expect(screen.getByTestId('call-reveal')).toHaveTextContent(/Not saved while recording is paused\./);
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
  });

  it('says a lock will be saved later when it could not be reached, and when the server will not take it', async () => {
    const waiting = await reader(playing([lockedCall({ keeping: 'waiting' })]).play);
    expect(screen.getByText("Will save when you're back online.")).toBeOnTheScreen();
    await waiting.unmount();
    await reader(playing([lockedCall({ keeping: 'refused' })]).play);
    expect(screen.getByText("Couldn't save this one.")).toBeOnTheScreen();
  });

  it('keeps the Final call on the device: its answer shows, and the play layer is not asked', async () => {
    const { play, asked } = playing();
    await reader(play);
    await fireEvent.press(screen.getByRole('radio', { name: /Warm, the southern half leans toward the Sun/ }));
    const locks = screen.getAllByRole('button', { name: 'Lock it in' });
    const last = locks[locks.length - 1];
    if (last === undefined) throw new Error('the Final call has a Lock it in button');
    await fireEvent.press(last);
    expect(asked).not.toHaveBeenCalled();
    expect(screen.getAllByText('Plot twist!').length).toBeGreaterThan(0);
    expect(screen.queryByText('+1 spark')).not.toBeOnTheScreen();
  });

  it('keeps play on the device when the app gives it none: a spark for a right call', async () => {
    await reader();
    await fireEvent.press(screen.getByRole('radio', { name: /Delhi’s half of Earth leans toward the Sun/ }));
    await fireEvent.press(firstLock());
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
    expect(screen.getByText('+1 spark')).toBeOnTheScreen();
  });
});

describe('what the screen says of a lock that is not kept', () => {
  it('says so for a pause, a wait and a refusal, and nothing when it is kept or only on the device', () => {
    expect(keepingNote('recording_paused')).toBe('Not saved while recording is paused.');
    expect(keepingNote('waiting')).toBe("Will save when you're back online.");
    expect(keepingNote('refused')).toBe("Couldn't save this one.");
    expect(keepingNote('saved')).toBeUndefined();
    expect(keepingNote('device_only')).toBeUndefined();
  });
});

describe('the dock', () => {
  it('shows the sparks of this Scroll, in words for a screen reader', async () => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderDock onAsk={() => undefined} sparks={1} />
      </DisplayProvider>,
    );
    expect(screen.getByLabelText('1 spark')).toBeOnTheScreen();
  });

  it('has no sparks chip when play is not on this screen, and says "0 sparks" before the first', async () => {
    const view = await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderDock onAsk={() => undefined} />
      </DisplayProvider>,
    );
    expect(screen.queryByTestId('spark-chip')).not.toBeOnTheScreen();
    await view.rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderDock onAsk={() => undefined} sparks={0} />
      </DisplayProvider>,
    );
    expect(screen.getByLabelText('0 sparks')).toBeOnTheScreen();
  });
});

describe('the options after the lock', () => {
  it('keep only what was called and what was right, so the reveal has the room', async () => {
    await reader(playing([lockedCall({ option: 0, correct: false, combo: 0 })]).play);
    expect(screen.getByRole('radio', { name: /Earth is closer to the Sun in June/ })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: /Delhi’s half of Earth leans toward the Sun/ })).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: /The Sun burns hotter in June/ })).not.toBeOnTheScreen();
  });

  it('are all there before the lock', async () => {
    await reader(playing().play);
    expect(screen.getByRole('radio', { name: /The Sun burns hotter in June/ })).toBeOnTheScreen();
  });
});
