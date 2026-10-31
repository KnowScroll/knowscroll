import { useState } from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { StageLock, StagePlay } from '@knowscroll/ui';
import stageDocument from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { CallItStop, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { AskPuzzle } from './ask-puzzle';

/** The labelled CI fixture, opened as the encounter opens a v2 Scroll (never product content). */
const document = stageDocument as unknown as ScrollDocumentV2;
const scroll: OpenedStageScroll = {
  exposureId: 'fixture-exposure',
  assetId: 'fixture-asset',
  assetRevision: 2,
  document,
  degradedEssential: [],
};
const calls = document.stops.filter((stop): stop is CallItStop => stop.kind === 'call_it');
const last = document.stops.at(-1)!.id;

/** A play layer that judges a lock the way the device does, and keeps it in memory. */
function Harness({ paused = false, locked = [] as readonly StageLock[] }) {
  const [locks, setLocks] = useState<readonly StageLock[]>(locked);
  const play: StagePlay = {
    locks,
    sparks: locks.filter((lock) => lock.correct).length,
    combo: 0,
    landmark: undefined,
    paused,
    lock: (stopId, option) =>
      setLocks((all) => [
        ...all,
        {
          stopId,
          option,
          correct: option === calls.find((call) => call.id === stopId)!.answer,
          combo: 1,
          earned: 1,
          finalCall: false,
          keeping: paused ? 'recording_paused' : 'saved',
        },
      ]),
  };
  return <AskPuzzle scroll={scroll} anchorStopId={last} play={play} />;
}

describe('the puzzle in the wait', () => {
  it('is one of the Scroll own calls, with its options in order, and shows nothing before a pick', async () => {
    const screen = await render(<Harness />);
    expect(screen.getByText('MEANWHILE · 20-SECOND PUZZLE')).toBeTruthy();
    expect(screen.getByText(calls.at(-1)!.prompt)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(calls.at(-1)!.options.length);
    expect(screen.queryByTestId('ask-puzzle-reveal')).toBeNull();
  });

  it('judges a right pick as "Called it!" with its spark, and why', async () => {
    const screen = await render(<Harness />);
    const call = calls.at(-1)!;
    await fireEvent.press(screen.getByRole('radio', { name: new RegExp(`^${String(call.answer + 1)}\\. `) }));
    expect(screen.getByText('Called it!')).toBeTruthy();
    expect(screen.getByText('+1 spark')).toBeTruthy();
    expect(screen.getByText(call.explain)).toBeTruthy();
    expect(screen.queryByText('Plot twist!')).toBeNull();
  });

  it('judges a wrong pick as a Plot twist, never a failure, with the warm second look and no spark', async () => {
    const screen = await render(<Harness />);
    const call = calls.at(-1)!;
    const wrong = (call.answer + 1) % call.options.length;
    await fireEvent.press(screen.getByRole('radio', { name: new RegExp(`^${String(wrong + 1)}\\. `) }));
    expect(screen.getByText('Plot twist!')).toBeTruthy();
    expect(screen.getByText(call.twist)).toBeTruthy();
    expect(screen.queryByText('+1 spark')).toBeNull();
    // Once shown, the answer stays: a second tap changes nothing.
    expect(screen.getAllByRole('radio')[0]).toBeDisabled();
  });

  it('says nothing is saved while recording is paused, and is no puzzle at all once every call was played', async () => {
    const paused = await render(<Harness paused />);
    await fireEvent.press(paused.getAllByRole('radio')[0]!);
    expect(paused.getByText('Not saved while recording is paused.')).toBeTruthy();
    await paused.unmount();
    const played = calls.map((call): StageLock => ({
      stopId: call.id,
      option: call.answer,
      correct: true,
      combo: 1,
      earned: 1,
      finalCall: false,
      keeping: 'saved',
    }));
    const none = await render(<Harness locked={played} />);
    expect(none.queryByTestId('ask-puzzle')).toBeNull();
  });
});
