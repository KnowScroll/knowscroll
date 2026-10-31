import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ThreadCall, ThreadEpisode } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { CallBar, CallCard } from './call-together';
import { EpisodeList } from './episode-list';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const asha = person(10, 'Asha');
const ravi = person(11, 'Ravi');
const kenji = person(12, 'Kenji');

const base = {
  part: 2,
  assetId: id(40),
  assetRevision: 1,
  prompt: 'When are tides biggest?',
  options: ['Full and new moon', 'Half moon', 'Always the same'],
  called: 2,
  of: 4,
};
const open: ThreadCall = { ...base, stage: 'open' };
type Revealed = Extract<ThreadCall, { stage: 'revealed' }>;
const revealed = (patch: Partial<Revealed> = {}): Revealed => ({
  ...base,
  stage: 'revealed',
  option: 0,
  answer: 0,
  explain: 'Spring tides come at full and new moon, when the pulls add.',
  right: true,
  picks: [
    { person: asha, you: true, option: 0, right: true },
    { person: kenji, you: false, option: 0, right: true },
    { person: ravi, you: false, option: 1, right: false },
  ],
  rightCount: 2,
  ...patch,
});

const inDisplay = (node: React.ReactElement) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>
);
const card = (call: ThreadCall, props: Partial<Parameters<typeof CallCard>[0]> = {}) => {
  const onLock = jest.fn();
  const onClose = jest.fn();
  return {
    onLock,
    onClose,
    element: inDisplay(
      <CallCard call={call} notice={undefined} locking={false} onLock={onLock} onClose={onClose} {...props} />,
    ),
  };
};

describe('a call before a part (T3 frame 4)', () => {
  it('shows the question and options, and Lock it in only after an option is chosen', async () => {
    const { element, onLock } = card(open);
    await render(element);
    expect(screen.getByText('CALL IT TOGETHER · BEFORE PART 2')).toBeOnTheScreen();
    expect(screen.getByText('When are tides biggest?')).toBeOnTheScreen();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Lock it in' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('radio', { name: 'Option B. Half moon' }));
    expect(screen.getByRole('radio', { name: 'Option B. Half moon' })).toBeChecked();
    await fireEvent.press(screen.getByRole('button', { name: 'Lock it in' }));
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it('counts who called without naming anyone, and carries no pick, answer or person', async () => {
    const { element } = card(open);
    await render(element);
    expect(screen.getByText('2 of 4 have called · answers stay hidden until you call')).toBeOnTheScreen();
    const json = JSON.stringify(screen.toJSON());
    expect(json).not.toMatch(/Spring tides|Plot twist|PLOT TWIST|Called it|Ravi|Kenji|Asha/);
  });

  it('can be driven by keys: a number chooses an option and Enter locks it', async () => {
    const { element, onLock } = card(open);
    await render(element);
    const region = screen.getByTestId('call-card');
    await fireEvent(region, 'keyDown', { nativeEvent: { key: '3' }, key: '3' });
    await fireEvent(region, 'keyDown', { nativeEvent: { key: 'Enter' }, key: 'Enter' });
    expect(onLock).toHaveBeenCalledWith(2);
  });

  it('locks with Enter on the option that is already chosen, and only then', async () => {
    const { element, onLock } = card(open);
    await render(element);
    const radio = screen.getByRole('radio', { name: 'Option C. Always the same' });
    // Enter on an option that is not chosen only chooses it (the press does that); it does not lock.
    await fireEvent(radio, 'keyDown', { nativeEvent: { key: 'Enter' } });
    expect(onLock).not.toHaveBeenCalled();
    await fireEvent.press(radio);
    await fireEvent(radio, 'keyDown', { nativeEvent: { key: 'Enter' } });
    expect(onLock).toHaveBeenCalledWith(2);
  });

  it('does not lock twice while a lock is on its way', async () => {
    const { element, onLock } = card(open, { locking: true });
    await render(element);
    expect(screen.getByRole('button', { name: 'Locking' })).toBeDisabled();
    expect(onLock).not.toHaveBeenCalled();
  });

  it('says the call changed while the person was choosing, and that nothing was locked', async () => {
    const { element } = card(open, { notice: 'changed' });
    await render(element);
    expect(screen.getByTestId('call-notice')).toHaveTextContent(/This call changed\./);
    expect(screen.getByTestId('call-notice')).toHaveTextContent(/nothing was locked/);
  });

  it('says why a lock was not kept: recording paused, or nothing saved', async () => {
    const paused = card(open, { notice: 'paused' });
    await render(paused.element);
    expect(screen.getByTestId('call-notice')).toHaveTextContent(/Recording is paused/);
    await screen.unmount();
    const failed = card(open, { notice: 'failed' });
    await render(failed.element);
    expect(screen.getByTestId('call-notice')).toHaveTextContent(/Couldn’t lock it in/);
  });
});

describe('after the person locked, before the reveal', () => {
  const locked: ThreadCall = { ...base, stage: 'locked', option: 1 };

  it('marks the person’s own call, cannot be changed, and says what it waits for', async () => {
    const { element } = card(locked);
    await render(element);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
    expect(screen.getByLabelText('Option B. Half moon. Your call.')).toBeOnTheScreen();
    expect(
      screen.getByText(/everyone who shares where they are has finished Part 2, or after two days/),
    ).toBeOnTheScreen();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/Spring tides|Plot twist|Ravi|Kenji/);
  });
});

describe('a Scroll that was updated since the call began (D-233)', () => {
  it('says the call keeps the question the thread called on, on an open call, a locked call and a reveal', async () => {
    for (const call of [
      { ...base, stage: 'open', updated: 'held' } as ThreadCall,
      { ...base, stage: 'locked', option: 1, updated: 'held' } as ThreadCall,
      revealed({ updated: 'held' }),
    ]) {
      const { element } = card(call);
      const view = await render(element);
      expect(screen.getByTestId('call-updated')).toHaveTextContent(
        /^Part 2 has been updated since your thread started calling\. The call keeps the question your thread called on/,
      );
      await view.unmount();
    }
  });

  it('says the new question is asked afresh when the earlier one cannot be shown, and says nothing for a current call', async () => {
    const afresh = card({ ...open, updated: 'restarted' });
    const view = await render(afresh.element);
    expect(screen.getByTestId('call-updated')).toHaveTextContent(/This call asks the new question afresh\.$/);
    await view.unmount();
    await render(card(open).element);
    expect(screen.queryByTestId('call-updated')).toBeNull();
  });
});

describe('the reveal (T3 frame 5)', () => {
  it('shows a right call as Called it! with a spark for the party, the answer, the explanation and who called what', async () => {
    const { element } = card(revealed());
    await render(element);
    expect(screen.getByText('CALLED IT! · REVEALED TOGETHER')).toBeOnTheScreen();
    expect(screen.getByTestId('call-spark')).toHaveTextContent('★ +1 for 2 of you');
    expect(
      screen.getByLabelText('Option A. Full and new moon. Right answer. Called by you and Kenji.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Option B. Half moon. Called by Ravi.')).toBeOnTheScreen();
    expect(screen.getByTestId('call-explain')).toHaveTextContent(/Spring tides come at full and new moon/);
    expect(screen.queryByTestId('call-twist')).toBeNull();
    expect(screen.queryByText('PLOT TWIST', { includeHiddenElements: true })).toBeNull();
  });

  it('shows a wrong call as a plot twist, with the warm second look and no spark, never a loss', async () => {
    const wrong = revealed({
      option: 1,
      right: false,
      twist: 'Half moon gives the smaller neap tides.',
      picks: [
        { person: asha, you: true, option: 1, right: false },
        { person: ravi, you: false, option: 0, right: true },
      ],
      rightCount: 1,
    });
    const { element } = card(wrong);
    await render(element);
    expect(screen.getByText('PLOT TWIST! · REVEALED TOGETHER')).toBeOnTheScreen();
    // The tag is decorative: the row's own label says it for a screen reader.
    expect(screen.getByText('PLOT TWIST', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByLabelText('Option B. Half moon. Your call: a plot twist. Called by you.')).toBeOnTheScreen();
    expect(screen.getByTestId('call-twist')).toHaveTextContent('Half moon gives the smaller neap tides.');
    expect(screen.queryByTestId('call-spark')).toBeNull();
    expect(screen.getByTestId('call-card')).not.toHaveTextContent(/-1|lost|wrong|incorrect|miss/i);
  });

  it('shows the Scroll’s reviewed common guess only when the server sent its source, worded as the reader words it', async () => {
    const without = card(revealed());
    await render(without.element);
    expect(screen.queryByTestId('call-common-guess')).toBeNull();
    await screen.unmount();
    const withGuess = card(revealed({ guessSource: 'A Private Universe' }));
    await render(withGuess.element);
    expect(screen.getByTestId('call-common-guess')).toHaveTextContent('The common guess. Source: A Private Universe.');
    // Nothing built from other threads' picks: no percent, no count.
    expect(screen.getByTestId('call-card')).not.toHaveTextContent(/%|across threads|most called/i);
  });
});

describe('a call that closed without the person', () => {
  it('says so, and offers nothing to pick', async () => {
    const { element } = card({ ...base, stage: 'closed', reason: 'revealed' });
    await render(element);
    expect(screen.getByText(/revealed without you/)).toBeOnTheScreen();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
  });
});

describe('the bar and the chip', () => {
  it('names the call in counts only, and opens it', async () => {
    const onOpen = jest.fn();
    await render(inDisplay(<CallBar call={open} onOpen={onOpen} />));
    await fireEvent.press(screen.getByRole('button', { name: /Call it first · 2 of 4 in/ }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('offers no bar for a call that is closed', async () => {
    await render(inDisplay(<CallBar call={{ ...base, stage: 'closed', reason: 'started' }} onOpen={jest.fn()} />));
    expect(screen.queryByTestId('call-bar')).toBeNull();
  });

  const episode = (n: number): ThreadEpisode => ({
    assetId: id(300 + n),
    assetRevision: 1,
    kind: 'scroll',
    part: n,
    title: `Part title ${String(n)}`,
    state: 'ready',
    visited: false,
  });

  it('sits under the part it comes before in the series list, and a press opens the call and does not choose the part', async () => {
    const onSelect = jest.fn();
    const onCall = jest.fn();
    await render(
      inDisplay(
        <EpisodeList
          episodes={[episode(1), episode(2), episode(3)]}
          selected={episode(1).assetId}
          series
          calls={[open]}
          onSelect={onSelect}
          onStep={jest.fn()}
          onCall={onCall}
        />,
      ),
    );
    expect(screen.getAllByTestId(/^call-chip-/)).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('call-chip-2'));
    expect(onCall).toHaveBeenCalledWith(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is absent for a part with no call', async () => {
    await render(
      inDisplay(
        <EpisodeList
          episodes={[episode(1), episode(2)]}
          selected={episode(1).assetId}
          series
          calls={[]}
          onSelect={jest.fn()}
          onStep={jest.fn()}
          onCall={jest.fn()}
        />,
      ),
    );
    expect(screen.queryByTestId(/^call-chip-/)).toBeNull();
  });
});
