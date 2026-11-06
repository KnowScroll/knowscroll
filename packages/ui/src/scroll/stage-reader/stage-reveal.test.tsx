import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { describeStageState, type ScrollDocumentV2, type StageState } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { FRESH_CALL } from './call-state';
import { StageReader } from './stage-reader';
import type { StagePlay, StageLock } from './stage-play';
import { pictureStopOf } from './stage-reveal';
import type { StageReadingObserver } from './use-stop-reading';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
// The first render of the whole reader compiles the stage and every stop; on a busy machine that outlasts five seconds.
jest.setTimeout(20_000);

/**
 * The picture a wrong answer turns the stage to (D-383, V3 F3), over the labelled CI fixture `seasons-stage-ci` (not
 * product content), whose first call, "call-delhi", is pointed at the next stop, "closest-in-january". The right option of the
 * call is the second (index 1); the first (index 0) is the common guess.
 */
const base = seasons as unknown as ScrollDocumentV2;
const turning: ScrollDocumentV2 = {
  ...base,
  stops: base.stops.map((stop) =>
    stop.kind === 'call_it' && stop.id === 'call-delhi' ? { ...stop, revealStage: 'closest-in-january' } : stop,
  ),
};

/** What the stage says of the picture it shows (its description is its accessible name). */
const ON_THE_ORBIT_IN_JUNE = /on an orbit drawn to scale.*The time of year is June/u;
const TURNED_TO_JANUARY = /orbit stretched so that the nearest and farthest points show.*The time of year is January/u;

type Spy = { [Method in keyof StageReadingObserver]: jest.Mock<void, Parameters<StageReadingObserver[Method]>> };

function spy(): Spy {
  return {
    onBlockVisibility: jest.fn<void, Parameters<StageReadingObserver['onBlockVisibility']>>(),
    onBlockInteraction: jest.fn<void, Parameters<StageReadingObserver['onBlockInteraction']>>(),
    onActivity: jest.fn<void, Parameters<StageReadingObserver['onActivity']>>(),
  };
}

function reader(document: ScrollDocumentV2, observer: StageReadingObserver, play?: StagePlay) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <StageReader document={document} observer={observer} commands={{}} initialStopId="call-delhi" play={play} />
    </DisplayProvider>,
  );
}

const lockIt = () => {
  const lock = screen.getAllByRole('button', { name: 'Lock it in' })[0];
  if (lock === undefined) throw new Error('the first call has a Lock it in button');
  return lock;
};

const pick = (option: RegExp) => fireEvent.press(screen.getByRole('radio', { name: option }));
const WRONG = /Earth is closer to the Sun in June/u;
const RIGHT = /Delhi’s half of Earth leans toward the Sun/u;

describe('the picture a wrong answer turns the stage to', () => {
  it('shows the picture the call sits over until the reader has locked an answer, a pick included', async () => {
    await reader(turning, spy());
    expect(screen.getByLabelText(ON_THE_ORBIT_IN_JUNE)).toBeOnTheScreen();
    await pick(WRONG);
    expect(screen.getByLabelText(ON_THE_ORBIT_IN_JUNE)).toBeOnTheScreen();
    expect(screen.queryByLabelText(TURNED_TO_JANUARY)).not.toBeOnTheScreen();
  });

  it('turns to the true picture the moment a wrong answer is locked', async () => {
    await reader(turning, spy());
    await pick(WRONG);
    await fireEvent.press(lockIt());
    expect(screen.getByText('Plot twist!')).toBeOnTheScreen();
    expect(screen.getByLabelText(TURNED_TO_JANUARY)).toBeOnTheScreen();
    expect(screen.queryByLabelText(ON_THE_ORBIT_IN_JUNE)).not.toBeOnTheScreen();
  });

  it('keeps the picture and the flow for a right answer', async () => {
    await reader(turning, spy());
    await pick(RIGHT);
    await fireEvent.press(lockIt());
    expect(screen.getByText('Called it!')).toBeOnTheScreen();
    expect(screen.getByLabelText(ON_THE_ORBIT_IN_JUNE)).toBeOnTheScreen();
    expect(screen.queryByLabelText(TURNED_TO_JANUARY)).not.toBeOnTheScreen();
  });

  it('leaves a document that names no reveal as it is: a wrong answer changes no picture', async () => {
    await reader(base, spy());
    await pick(WRONG);
    await fireEvent.press(lockIt());
    expect(screen.getByText('Plot twist!')).toBeOnTheScreen();
    expect(screen.getByLabelText(ON_THE_ORBIT_IN_JUNE)).toBeOnTheScreen();
  });

  it('says the true picture in words in the text version too, since it is the picture that is on show', async () => {
    await reader(turning, spy());
    await pick(WRONG);
    await fireEvent.press(lockIt());
    await fireEvent.press(screen.getByLabelText('Text version'));
    expect(screen.getByText(TURNED_TO_JANUARY)).toBeOnTheScreen();
  });

  it('turns at once for a wrong answer the play layer already holds, as after a reload', async () => {
    const lock: StageLock = {
      stopId: 'call-delhi',
      option: 0,
      correct: false,
      combo: 0,
      earned: 0,
      finalCall: false,
      keeping: 'saved',
    };
    const play: StagePlay = { locks: [lock], sparks: 0, combo: 0, landmark: undefined, paused: false, lock: jest.fn() };
    await reader(turning, spy(), play);
    expect(screen.getByLabelText(TURNED_TO_JANUARY)).toBeOnTheScreen();
  });
});

/** A play layer that keeps what is locked, as the app's does, and records every lock the reader asks for. */
function KeepingPlay({
  asked,
  observer,
}: {
  readonly asked: jest.Mock<void, [string, number]>;
  readonly observer: StageReadingObserver;
}) {
  const [locks, setLocks] = useState<readonly StageLock[]>([]);
  const play: StagePlay = {
    locks,
    sparks: 0,
    combo: 0,
    landmark: undefined,
    paused: false,
    lock: (stopId, option) => {
      asked(stopId, option);
      setLocks((all) => [
        ...all,
        { stopId, option, correct: option === 1, combo: 0, earned: 0, finalCall: false, keeping: 'saved' },
      ]);
    },
  };
  return (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <StageReader document={turning} observer={observer} commands={{}} initialStopId="call-delhi" play={play} />
    </DisplayProvider>
  );
}

describe('a true picture that carries figures a passage stated (D-382)', () => {
  /** CI fixture figures of the invented planet Orrin: the true picture is the closest view, with its two distances. */
  const stage = turning.stage;
  if (stage === undefined) throw new Error('the fixture has a stage');
  const withFigures: ScrollDocumentV2 = {
    ...turning,
    stage: {
      ...stage,
      states: stage.states.map((entry) => {
        if (entry.stop !== 'closest-in-january') return entry;
        const state = {
          ...entry.state,
          figures: [
            { slot: 'nearest', value: 41_000_000, unit: 'kilometres' },
            { slot: 'farthest', value: 43_000_000, unit: 'kilometres' },
          ],
        };
        return { ...entry, state, alt: describeStageState(state as StageState) };
      }),
    } as NonNullable<ScrollDocumentV2['stage']>,
  };

  it('shows the figures with the true picture after a wrong answer, and never before it', async () => {
    await reader(withFigures, spy());
    expect(screen.queryByLabelText(/At its nearest, Earth is 41,000,000 kilometres/u)).not.toBeOnTheScreen();
    await pick(WRONG);
    await fireEvent.press(lockIt());
    expect(screen.getByLabelText(/At its nearest, Earth is 41,000,000 kilometres from the Sun/u)).toBeOnTheScreen();
    expect(screen.getByLabelText(/Earth is marked “You are here”/u)).toBeOnTheScreen();
  });

  it('keeps them off the picture of a reader who answered right, who meets the true picture at the next stop', async () => {
    await reader(withFigures, spy());
    await pick(RIGHT);
    await fireEvent.press(lockIt());
    expect(screen.queryByLabelText(/At its nearest/u)).not.toBeOnTheScreen();
  });
});

describe('what the turn tells anyone (D-063)', () => {
  it('is nothing: the reader reports the reveal by kind as before, with no field about the picture or the pick, and the play layer hears the lock alone', async () => {
    const observer = spy();
    const asked = jest.fn<void, [string, number]>();
    await render(<KeepingPlay asked={asked} observer={observer} />);
    await pick(WRONG);
    await fireEvent.press(lockIt());
    expect(screen.getByLabelText(TURNED_TO_JANUARY)).toBeOnTheScreen();
    expect(observer.onBlockInteraction).toHaveBeenCalledTimes(1);
    const event = observer.onBlockInteraction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(['at', 'blockId', 'kind']);
    expect(JSON.stringify(event)).not.toMatch(/closest-in-january|revealStage|picked|option/u);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith('call-delhi', 0);
    expect(
      [...observer.onActivity.mock.calls, ...observer.onBlockVisibility.mock.calls]
        .map((call) => JSON.stringify(call))
        .join(''),
    ).not.toMatch(/closest-in-january|revealStage/u);
  });
});

describe('which stop’s picture the stage shows (pictureStopOf)', () => {
  const call = turning.stops.find((stop) => stop.id === 'call-delhi');
  const read = turning.stops.find((stop) => stop.kind === 'read');
  if (call === undefined || read === undefined) throw new Error('the fixture has a call and a read stop');
  const locked = (picked: number) => ({ picked, revealed: true });

  it('is the stop itself unless a Call it that names a picture was answered wrongly', () => {
    expect(pictureStopOf(read, undefined)).toBe(read.id);
    expect(pictureStopOf(call, FRESH_CALL)).toBe('call-delhi');
    if (call?.kind !== 'call_it') throw new Error('CI fixture has a Call it');
    expect(pictureStopOf(call, { picked: undefined, revealed: true })).toBe(call.revealStage);
    expect(pictureStopOf(call, { picked: 0, revealed: false })).toBe('call-delhi');
    expect(pictureStopOf(call, locked(1))).toBe('call-delhi');
    expect(pictureStopOf(call, locked(0))).toBe('closest-in-january');
    expect(pictureStopOf(undefined, undefined)).toBeUndefined();
  });

  it('does not turn for a call that names no picture, whatever was answered', () => {
    const plain = base.stops.find((stop) => stop.id === 'call-delhi');
    expect(pictureStopOf(plain, locked(0))).toBe('call-delhi');
  });
});
