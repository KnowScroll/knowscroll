import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '../../display/display';
import { QuickAnswerCard, type QuickAnswerView } from './quick-answer-card';

const LABEL = 'Quick answer · not a checked Scroll';

async function card(view: QuickAnswerView, handlers: Partial<Parameters<typeof QuickAnswerCard>[0]> = {}) {
  const onMakeScroll = jest.fn();
  const onReport = jest.fn();
  const onFollowUp = jest.fn();
  const onClose = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <QuickAnswerCard
        view={view}
        label={LABEL}
        followUpMax={200}
        onMakeScroll={onMakeScroll}
        onReport={onReport}
        onFollowUp={onFollowUp}
        onClose={onClose}
        {...handlers}
      />
    </DisplayProvider>,
  );
  return { onMakeScroll, onReport, onFollowUp, onClose };
}

const answered: QuickAnswerView = {
  phase: 'answered',
  question: 'Why does it keep pointing?',
  answer: 'Nothing turns the axis during a year.',
  covered: true,
  canMakeScroll: true,
};

describe('the Quick answer card (V3 D2)', () => {
  it('says it is a Quick answer and not a checked Scroll in every state', async () => {
    for (const view of [
      { phase: 'working', canMakeScroll: false },
      answered,
      { phase: 'unavailable', message: 'We couldn’t answer that one.', canMakeScroll: true },
    ] as const) {
      const { unmount } = await render(
        <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
          <QuickAnswerCard
            view={view}
            label={LABEL}
            followUpMax={200}
            onMakeScroll={jest.fn()}
            onReport={jest.fn()}
            onFollowUp={jest.fn()}
            onClose={jest.fn()}
          />
        </DisplayProvider>,
      );
      expect(screen.getByText(LABEL.toUpperCase())).toBeOnTheScreen();
      expect(screen.getByLabelText(LABEL)).toBeOnTheScreen();
      await unmount();
    }
  });

  it('shows the question and the answer, and offers the full Scroll, a follow-up, Report and Close', async () => {
    const { onMakeScroll, onReport, onClose } = await card(answered);
    expect(screen.getByText('Why does it keep pointing?')).toBeOnTheScreen();
    expect(screen.getByText('Nothing turns the axis during a year.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Make it a full Scroll' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Report' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(onMakeScroll).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can be reported only once there is an answer to report, and offers no full Scroll while it is being made', async () => {
    await card({ phase: 'working', canMakeScroll: false });
    expect(screen.getByText('Answering from what you have read…')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Report' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Make it a full Scroll' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Ask a follow-up' })).not.toBeOnTheScreen();
  });

  it('leaves out the full Scroll where it is not a way on, and says why there is no answer', async () => {
    await card({
      phase: 'unavailable',
      message: 'Quick answers are off while recording is paused.',
      canMakeScroll: false,
    });
    expect(screen.getByText('Quick answers are off while recording is paused.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Make it a full Scroll' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Report' })).not.toBeOnTheScreen();
  });

  it('sends a follow-up the person typed, only once it has words, and puts the box away', async () => {
    const { onFollowUp } = await card(answered);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask a follow-up' }));
    const input = screen.getByLabelText('Your follow-up question');
    await fireEvent.changeText(input, 'ab');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    await fireEvent.changeText(input, '  And then what?  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(onFollowUp).toHaveBeenCalledWith('And then what?');
    expect(screen.queryByLabelText('Your follow-up question')).not.toBeOnTheScreen();
  });
});
