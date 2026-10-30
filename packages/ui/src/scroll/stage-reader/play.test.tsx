import { fireEvent, render, screen, within } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { keepingNote } from './call-state';
import { ReaderDock } from './reader-chrome';
import type { StageLandmark, StageLock, StagePlay } from './stage-play';
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
function playing(locks: readonly StageLock[] = [], paused = false, landmark?: StageLandmark) {
  const asked = jest.fn<void, [string, number]>();
  const play: StagePlay = {
    locks,
    sparks: locks.reduce((sum, lock) => sum + lock.earned, 0),
    combo: locks.at(-1)?.combo ?? 0,
    landmark,
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
  earned: 1,
  finalCall: false,
  keeping: 'saved',
  ...over,
});

/** The Final call of the fixture (its right answer is the first option). */
const lockedFinal = (over: Partial<StageLock> = {}): StageLock =>
  lockedCall({ stopId: 'final-tilt', option: 0, finalCall: true, ...over });

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
    expect(within(screen.getByTestId('call-reveal')).getByText('Combo ×2')).toBeOnTheScreen();
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
    // Each open call says so before the lock, the Final call too ...
    const view = await reader(playing([], true).play);
    expect(screen.getAllByText('Not saved while recording is paused.')).toHaveLength(3);
    await view.unmount();
    // ... and the one that was locked says it in its reveal, in place of the line before the lock.
    await reader(playing([lockedCall({ keeping: 'recording_paused' })], true).play);
    expect(screen.getAllByText('Not saved while recording is paused.')).toHaveLength(3);
    expect(screen.getByTestId('call-reveal')).toHaveTextContent(/Not saved while recording is paused\./, {
      exact: false,
    });
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
  });

  it('says a lock will be saved later when it could not be reached, and when the server will not take it', async () => {
    const waiting = await reader(playing([lockedCall({ keeping: 'waiting' })]).play);
    expect(screen.getByText("Will save when you're back online.")).toBeOnTheScreen();
    await waiting.unmount();
    await reader(playing([lockedCall({ keeping: 'refused' })]).play);
    expect(screen.getByText("Couldn't save this one.")).toBeOnTheScreen();
  });

  it('hands a locked Final call to the play layer like any call, and reports only that the answer was shown', async () => {
    const observer = spy();
    const { play, asked } = playing();
    await reader(play, observer);
    await fireEvent.press(screen.getByRole('radio', { name: /The north stays in summer all year/ }));
    const locks = screen.getAllByRole('button', { name: 'Lock it in' });
    const last = locks[locks.length - 1];
    if (last === undefined) throw new Error('the Final call has a Lock it in button');
    await fireEvent.press(last);
    expect(asked).toHaveBeenCalledWith('final-tilt', 1);
    expect(observer.onBlockInteraction).toHaveBeenCalledTimes(1);
    expect(Object.keys(observer.onBlockInteraction.mock.calls[0]?.[0] as object).sort()).toEqual([
      'at',
      'blockId',
      'kind',
    ]);
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

const gold: StageLandmark = { key: 'the-leaning-axis', name: 'The Leaning Axis', tier: 'gold' };
const plain: StageLandmark = { ...gold, tier: 'plain' };

describe('the Final call (D-187, D-188)', () => {
  it('says what it is for before the lock: the way to the gold landmark, and the tilt to turn', async () => {
    await reader(playing().play);
    expect(screen.getByText('Final call')).toBeOnTheScreen();
    expect(screen.getByTestId('final-call-gold-note')).toHaveTextContent('Get it first try for the gold landmark', {
      exact: false,
    });
    expect(screen.getByTestId('tilt-control')).toBeOnTheScreen();
    expect(screen.getByTestId('tilt-value')).toHaveTextContent('23.4°', { exact: false });
    expect(screen.getByRole('slider', { name: 'Earth’s tilt' })).toBeOnTheScreen();
    // No combo is waiting yet.
    expect(screen.queryByTestId('final-call-combo')).not.toBeOnTheScreen();
  });

  it('announces the combo bonus when a combo of two is waiting, and not for one', async () => {
    const view = await reader(playing([lockedCall({ combo: 1 })]).play);
    expect(screen.queryByTestId('final-call-combo')).not.toBeOnTheScreen();
    await view.unmount();
    await reader(
      playing([lockedCall({ combo: 1 }), lockedCall({ stopId: 'call-december', option: 0, combo: 2 })]).play,
    );
    expect(screen.getByTestId('final-call-combo')).toHaveTextContent('Combo ×2 doubles this one', { exact: false });
  });

  it('turns the tilt on the picture the reader is looking at, and nothing is handed to the play layer for it', async () => {
    const { play, asked } = playing();
    await reader(play);
    const slider = screen.getByRole('slider', { name: 'Earth’s tilt' });
    await fireEvent(slider, 'keyDown', { nativeEvent: { key: 'Home' }, preventDefault: () => undefined });
    expect(screen.getByTestId('tilt-value')).toHaveTextContent('0°', { exact: false });
    expect(asked).not.toHaveBeenCalled();
  });

  it('shows two sparks for a right Final call after a combo, and the plain-finish reassurance for a miss', async () => {
    const view = await reader(playing([lockedFinal({ earned: 2, combo: 3 })], false, gold).play);
    expect(screen.getByText('+2 sparks')).toBeOnTheScreen();
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
    expect(screen.queryByTestId('landmark-still-earned')).not.toBeOnTheScreen();
    await view.unmount();
    await reader(playing([lockedFinal({ option: 1, correct: false, combo: 0, earned: 0 })], false, plain).play);
    expect(screen.getAllByText('Plot twist!').length).toBeGreaterThan(0);
    expect(screen.getByTestId('landmark-still-earned')).toHaveTextContent(
      'You still earn the landmark, in the plain finish.',
      { exact: false },
    );
  });

  it('keeps the tilt control and the gold note off a Scroll that hands none and names no landmark', async () => {
    const { stage, ...bare } = document;
    const stops = bare.stops.map((stop) => {
      if (stop.kind !== 'final_call') return stop;
      const { binding: _binding, ...rest } = stop;
      return rest;
    });
    const { landmark: _landmark, ...withoutLandmark } = bare;
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <StageReader document={{ ...withoutLandmark, stops, stage }} commands={{}} play={playing().play} />
      </DisplayProvider>,
    );
    expect(screen.queryByTestId('tilt-control')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('final-call-gold-note')).not.toBeOnTheScreen();
  });
});

describe('the payoff at the end (E1, D-189)', () => {
  it('shows the score row, the gold landmark with its name, and every way on at the same time', async () => {
    const locks = [
      lockedCall({ combo: 1 }),
      lockedCall({ stopId: 'call-december', option: 0, combo: 2 }),
      lockedFinal({ earned: 2, combo: 3 }),
    ];
    await reader(playing(locks, false, gold).play);
    const score = screen.getByTestId('payoff-score');
    expect(score).toHaveTextContent('4 sparks', { exact: false });
    expect(score).toHaveTextContent('Combo ×3', { exact: false });
    expect(score).toHaveTextContent('Final call ✓', { exact: false });
    const card = screen.getByTestId('landmark-card');
    expect(card).toHaveTextContent('Gold landmark', { exact: false });
    expect(card).toHaveTextContent('The Leaning Axis', { exact: false });
    expect(card).toHaveTextContent('Gold finish, first try.', { exact: false });
    expect(screen.getByRole('button', { name: 'Done for today' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Small print' })).toBeOnTheScreen();
  });

  it('shows a plain landmark, never a lesser one, when the Final call missed', async () => {
    await reader(playing([lockedFinal({ option: 1, correct: false, combo: 0, earned: 0 })], false, plain).play);
    const card = screen.getByTestId('landmark-card');
    expect(card).toHaveTextContent('The Leaning Axis', { exact: false });
    expect(card).toHaveTextContent('Plain finish.', { exact: false });
    expect(card).not.toHaveTextContent('Gold', { exact: false });
    expect(screen.getByTestId('payoff-score')).toHaveTextContent('Final call · Plot twist', { exact: false });
  });

  it('shows no landmark card for a Scroll that awarded none, and a way back to a Final call still open', async () => {
    const { play } = playing([lockedCall()]);
    await reader(play);
    expect(screen.queryByTestId('landmark-card')).not.toBeOnTheScreen();
    expect(screen.getByTestId('payoff-score')).toHaveTextContent('Final call · still open', { exact: false });
    expect(screen.getByRole('button', { name: 'Play the Final call' })).toBeOnTheScreen();
  });

  it('says in the card that the landmark is not kept while recording is paused, and when it could not be reached', async () => {
    const view = await reader(playing([lockedFinal({ keeping: 'recording_paused' })], true, gold).play);
    expect(screen.getByTestId('landmark-note')).toHaveTextContent('Not saved while recording is paused.', {
      exact: false,
    });
    await view.unmount();
    await reader(playing([lockedFinal({ keeping: 'waiting' })], false, gold).play);
    expect(screen.getByTestId('landmark-note')).toHaveTextContent("Will save when you're back online.", {
      exact: false,
    });
  });

  it('opens the limits aside from the Small print chip, where it stands, and closes it again', async () => {
    await reader(playing([lockedFinal()], false, gold).play);
    expect(screen.queryByTestId('small-print')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Small print' }));
    expect(screen.getByTestId('small-print')).toHaveTextContent('Where this stops', { exact: false });
    expect(screen.getByTestId('small-print')).toHaveTextContent(/Light sets the season/, { exact: false });
    await fireEvent.press(screen.getByRole('button', { name: 'Small print' }));
    expect(screen.queryByTestId('small-print')).not.toBeOnTheScreen();
  });

  it('says a good place to stop for "Done for today" and leaves only when the person closes', async () => {
    const onDone = jest.fn();
    const onUniverse = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <StageReader
          document={document}
          commands={{ universe: onUniverse }}
          onDone={onDone}
          play={playing([lockedFinal({ earned: 1, combo: 1 })], false, gold).play}
        />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Done for today' }));
    expect(screen.getByText('A good place to stop.')).toBeOnTheScreen();
    expect(screen.getByTestId('done-for-today')).toHaveTextContent('Today: 1 spark. The Leaning Axis is yours.', {
      exact: false,
    });
    expect(onDone).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Open your Universe' }));
    expect(onUniverse).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to the end' }));
    expect(screen.queryByText('A good place to stop.')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Done for today' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('moves nowhere by itself: no way on is taken until a button is pressed', async () => {
    jest.useFakeTimers();
    try {
      const onPart = jest.fn();
      const onTopic = jest.fn();
      const onDone = jest.fn();
      await render(
        <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
          <StageReader
            document={document}
            commands={{ nextTopic: onTopic }}
            nextPart={{ label: 'Part 2', title: 'Fixture part two', onPress: onPart }}
            onDone={onDone}
            play={playing([lockedFinal()], false, gold).play}
          />
        </DisplayProvider>,
      );
      jest.advanceTimersByTime(120_000);
      expect([onPart, onTopic, onDone].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      jest.useRealTimers();
    }
  });
});
