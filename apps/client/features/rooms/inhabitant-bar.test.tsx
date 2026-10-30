import { fireEvent, render, screen } from '@testing-library/react-native';
import type { InhabitantStatus } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { InhabitantBar } from './inhabitant-bar';

const status = (ask: InhabitantStatus['ask']): InhabitantStatus[] => [
  { inhabitant: 'explainer', label: 'AI · Explainer', blurb: 'Answers when asked', ask },
  { inhabitant: 'skeptic', label: 'AI · Skeptic', blurb: 'Pushes back on claims', ask },
];

async function show(inhabitants: InhabitantStatus[], outcome?: string) {
  const onAsk = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <InhabitantBar inhabitants={inhabitants} asking={false} outcome={outcome} onAsk={onAsk} />
    </DisplayProvider>,
  );
  return { onAsk };
}

describe('the inhabitant bar', () => {
  it('shows each inhabitant with its label and asks only when the person presses Ask', async () => {
    const { onAsk } = await show(status('available'));
    expect(screen.getByText(/speak when someone asks/)).toBeOnTheScreen();
    // What asking sends is said once, on joining, and then in the room menu: not on every visit.
    expect(screen.queryByText(/without names/)).not.toBeOnTheScreen();
    expect(screen.getByRole('text', { name: 'AI, Explainer' })).toBeOnTheScreen();
    expect(screen.getByRole('text', { name: 'AI, Skeptic' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Ask AI, Skeptic' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledWith('skeptic');
  });

  it.each([
    ['preparing', 'is preparing a reply'],
    ['resting', 'is resting for today'],
    ['paused', 'is quiet while the room is paused'],
  ] as const)('says why it cannot be asked when %s, and does not ask', async (ask, words) => {
    const { onAsk } = await show(status(ask));
    expect(screen.getAllByText(words)).toHaveLength(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask AI, Skeptic' }));
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('shows the outcome of the last ask and nothing when the room has no inhabitants', async () => {
    await show(status('available'), 'AI · Skeptic had nothing to add.');
    expect(screen.getByText('AI · Skeptic had nothing to add.')).toBeOnTheScreen();
  });
});
