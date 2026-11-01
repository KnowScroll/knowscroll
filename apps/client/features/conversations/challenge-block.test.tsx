import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ChallengeCard } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { ChallengeBlock } from './challenge-block';

const base = {
  stopId: 'tides-call',
  prompt: 'When are tides biggest?',
  options: ['Full and new moon', 'Half moon', 'Always the same'],
};
const open: ChallengeCard = { ...base, stage: 'open' };
type Revealed = Extract<ChallengeCard, { stage: 'revealed' }>;
const revealed = (patch: Partial<Revealed> = {}): Revealed => ({
  ...base,
  stage: 'revealed',
  option: 0,
  theirs: 1,
  answer: 0,
  explain: 'Spring tides come at full and new moon, when the pulls add.',
  right: true,
  theirsRight: false,
  ...patch,
});

function block(challenge: ChallengeCard, props: Partial<Parameters<typeof ChallengeBlock>[0]> = {}) {
  const onLock = jest.fn();
  return {
    onLock,
    element: (
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ChallengeBlock
          challenge={challenge}
          friend="Ravi"
          notice={undefined}
          locking={false}
          onLock={onLock}
          {...props}
        />
      </DisplayProvider>
    ),
  };
}

describe('a challenge card in Talk (D-245)', () => {
  it('asks the question and lets the person call before anything of the friend is shown', async () => {
    const { element, onLock } = block(open);
    await render(element);
    expect(screen.getByText('CHALLENGE · CALL IT FIRST')).toBeOnTheScreen();
    expect(screen.getByTestId('challenge-prompt')).toHaveTextContent('When are tides biggest?');
    expect(screen.getByTestId('challenge-status')).toHaveTextContent(
      'Call it before you see Ravi’s. Both answers show once you have both called.',
    );
    expect(screen.getByTestId('challenge-lock')).toBeDisabled();
    await fireEvent.press(screen.getByRole('radio', { name: 'Option B. Half moon' }));
    await fireEvent.press(screen.getByTestId('challenge-lock'));
    expect(onLock).toHaveBeenCalledWith(1);
    // Nothing of the answer or the friend is on the card.
    expect(screen.queryByTestId('challenge-explain')).not.toBeOnTheScreen();
    expect(screen.queryByText(/YOU|RAVI/)).not.toBeOnTheScreen();
  });

  it('shows only the person’s own call while they wait, and no lock button', async () => {
    const { element } = block({ ...base, stage: 'locked', option: 2 });
    await render(element);
    expect(screen.getByTestId('challenge-status')).toHaveTextContent(
      'You called C. Ravi’s call shows once they have called too.',
    );
    expect(screen.getByLabelText('Option C. Always the same. Your call.')).toBeOnTheScreen();
    expect(screen.queryByTestId('challenge-lock')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('challenge-explain')).not.toBeOnTheScreen();
  });

  it('reveals both calls, the right answer and why once both have called, and a right call earns a spark', async () => {
    const { element } = block(revealed());
    await render(element);
    expect(screen.getByText('CALLED IT! · REVEALED')).toBeOnTheScreen();
    expect(screen.getByTestId('challenge-spark')).toHaveTextContent('★ +1 spark');
    expect(screen.getByTestId('challenge-status')).toHaveTextContent('You called A. Ravi called B.');
    expect(screen.getByLabelText('Option A. Full and new moon. Your call. Right answer.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Option B. Half moon. Ravi’s call.')).toBeOnTheScreen();
    expect(screen.getByTestId('challenge-explain')).toHaveTextContent(/Spring tides come/);
    expect(screen.queryByTestId('challenge-twist')).not.toBeOnTheScreen();
  });

  it('makes a wrong call a plot twist with the second look, never a loss', async () => {
    const { element } = block(
      revealed({
        option: 1,
        theirs: 0,
        right: false,
        theirsRight: true,
        twist: 'Half moon gives the smaller neap tides.',
      }),
    );
    await render(element);
    expect(screen.getByText('PLOT TWIST! · REVEALED')).toBeOnTheScreen();
    expect(screen.queryByTestId('challenge-spark')).not.toBeOnTheScreen();
    expect(screen.getByTestId('challenge-twist')).toHaveTextContent(/Half moon gives/);
    expect(screen.queryByText(/lost|wrong|miss|-1/i)).not.toBeOnTheScreen();
  });

  it('says why a call was not kept: recording paused, or nothing saved', async () => {
    const paused = block(open, { notice: 'paused' });
    await render(paused.element);
    expect(screen.getByText('Recording is paused.')).toBeOnTheScreen();
    await screen.unmount();
    const failed = block(open, { notice: 'failed' });
    await render(failed.element);
    expect(screen.getByText('Couldn’t lock it in.')).toBeOnTheScreen();
  });

  it('says on the card, before any pick, that recording is paused, and does not let a call be locked', async () => {
    const { element, onLock } = block(open, { recordingPaused: true });
    await render(element);
    expect(screen.getByTestId('challenge-notice')).toHaveTextContent(/Recording is paused./);
    await fireEvent.press(screen.getByRole('radio', { name: 'Option B. Half moon' }));
    expect(screen.getByTestId('challenge-lock')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('challenge-lock'));
    expect(onLock).not.toHaveBeenCalled();
  });

  it('says nothing about recording once the person has called, or when it is on', async () => {
    const waiting = block({ ...base, stage: 'locked', option: 2 }, { recordingPaused: true });
    await render(waiting.element);
    expect(screen.queryByTestId('challenge-notice')).not.toBeOnTheScreen();
    await screen.unmount();
    await render(block(open).element);
    expect(screen.queryByTestId('challenge-notice')).not.toBeOnTheScreen();
  });

  it('cannot be locked again while a pick is on its way', async () => {
    const { element, onLock } = block(open, { locking: true });
    await render(element);
    await fireEvent.press(screen.getByRole('radio', { name: 'Option A. Full and new moon' }));
    await fireEvent.press(screen.getByTestId('challenge-lock'));
    expect(onLock).not.toHaveBeenCalled();
  });
});
