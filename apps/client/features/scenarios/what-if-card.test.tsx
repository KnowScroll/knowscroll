import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ScenarioAnswer, ScenarioCard } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { BranchCard } from './branch-card';

const moon = { subject: 'Moon', statement: 'The Moon is twice as wide as it is' };
const orbit = { subject: 'Orbit', statement: 'Its distance, Earth’s spin and the Sun’s pull stay the same' };
const asha = {
  kind: 'person' as const,
  personId: '0199a000-0000-7000-8000-00000000000a',
  handle: 'ci.asha',
  displayName: 'Asha',
};
const answer: ScenarioAnswer = {
  status: 'ready',
  madeBy: 'knowscroll',
  assumption: 'We read “twice the size” as twice as wide, about the same rock.',
  answer: 'Tides would likely be much stronger, because a heavier moon pulls harder on the sea.',
  numbers: [{ label: 'Typical range today', value: 'about 2 m' }],
  readyAt: '2026-10-24T10:00:26.000Z',
};
const card = (patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: '0199a000-0000-7000-8000-000000000009',
  kind: 'what_if',
  origin: 'root',
  title: 'What if the Moon were twice its current size?',
  changes: [moon],
  kept: [orbit],
  hypothetical: true,
  speculative: false,
  assumptions: [moon],
  startedBy: asha,
  status: 'preparing',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  ...patch,
});
const scroll = {
  kind: 'scroll' as const,
  assetId: '0199a000-0000-7000-8000-0000000000aa',
  assetRevision: 1,
  title: 'A Scroll',
};
const soon = new Date('2026-10-24T10:00:05.000Z');

async function show(value: ScenarioCard, options: { starterIsYou?: boolean; openedByYou?: boolean; now?: Date } = {}) {
  const open = jest.fn();
  const remove = jest.fn();
  const next = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <BranchCard
        card={value}
        starterIsYou={options.starterIsYou ?? false}
        startedLine="from the thread"
        openedByYou={options.openedByYou ?? false}
        now={options.now ?? soon}
        onOpen={open}
        onRemove={remove}
        onContinue={next}
      />
    </DisplayProvider>,
  );
  return { open, remove, next };
}

describe('a what-if while its short answer is being made', () => {
  it('says it is made by KnowScroll, waits for about 30 s, and checks before it posts', async () => {
    await show(card({ answer: { status: 'making' } }));
    expect(
      screen.getByLabelText(/What-if · made by KnowScroll: What if the Moon were twice its current size\?, being made/),
    ).toBeOnTheScreen();
    expect(screen.getAllByText('What-if · made by KnowScroll').length).toBeGreaterThan(0);
    expect(screen.getByText('Making a short what-if · about 30 s · keep chatting')).toBeOnTheScreen();
    expect(screen.getByText('We check it before it posts.')).toBeOnTheScreen();
    // Nothing is claimed that has not happened: no answer, no "checked", no step list, and nothing to open.
    expect(screen.queryByText(/CHECKED/)).toBeNull();
    expect(screen.queryByText('ASSUMED')).toBeNull();
    expect(screen.queryByText('Open')).toBeNull();
    expect(screen.queryByText('Cancel')).toBeNull();
  });

  it('lets the one who asked cancel it, and nobody else', async () => {
    const { remove } = await show(card({ answer: { status: 'making' } }), { starterIsYou: true });
    await fireEvent.press(screen.getByText('Cancel'));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('says when the wait has gone past the usual, instead of repeating itself', async () => {
    await show(card({ answer: { status: 'making' } }), { now: new Date('2026-10-24T10:02:00.000Z') });
    expect(screen.getByText('Taking longer than usual · keep chatting')).toBeOnTheScreen();
    expect(screen.queryByText(/about 30 s/)).toBeNull();
  });
});

describe('a what-if with its short answer', () => {
  it('shows the assumption line, what changed and stayed, the answer and a sourced figure, labelled as made by KnowScroll', async () => {
    await show(card({ answer, status: 'ready', content: scroll }));
    expect(screen.getByTestId('what-if-label')).toHaveTextContent('What-if · made by KnowScroll');
    expect(screen.getByTestId('what-if-ready-line')).toHaveTextContent(/^WHAT-IF READY · MADE IN 26 S · /);
    expect(screen.getByText('FROM THE THREAD · ASKED BY ASHA · CHECKED')).toBeOnTheScreen();
    expect(screen.getByTestId('what-if-assumed')).toHaveTextContent(
      /ASSUMED\s*We read “twice the size” as twice as wide, about the same rock\./,
    );
    expect(screen.getByTestId('what-if-changed')).toHaveTextContent(/CHANGED\s*The Moon is twice as wide as it is/);
    expect(screen.getByTestId('what-if-kept')).toHaveTextContent(
      /KEPT\s*Its distance, Earth’s spin and the Sun’s pull stay the same/,
    );
    expect(screen.getByTestId('what-if-answer')).toHaveTextContent(answer.answer);
    expect(screen.getByText('TYPICAL RANGE TODAY')).toBeOnTheScreen();
    expect(screen.getByText('about 2 m')).toBeOnTheScreen();
    // Nothing of sources, scores, prompts, models or where anyone is.
    expect(screen.queryByText(/\bsources?\b|\bscores?\b|\bmodel\b|prompt|\bclaims?\b|watching|\bseen\b/i)).toBeNull();
  });

  it('opens the full Scroll once it exists, and branches again from the branch', async () => {
    const { open, next } = await show(card({ answer, status: 'ready', content: scroll }));
    await fireEvent.press(screen.getByText('Open'));
    expect(open).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('Branch again'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('offers no Open while the full Scroll is being made, and says so', async () => {
    await show(card({ answer, status: 'preparing' }));
    expect(screen.queryByText('Open')).toBeNull();
    expect(screen.queryByText('Branch again')).toBeNull();
    expect(screen.getByTestId('what-if-scroll-note')).toHaveTextContent(/The full Scroll is still being made\./);
  });

  it('stands on its own when the full Scroll could not be made', async () => {
    await show(card({ answer, status: 'failed' }));
    expect(screen.getByTestId('what-if-scroll-note')).toHaveTextContent(/couldn’t be made\. This card still stands\./);
    expect(screen.getByTestId('what-if-answer')).toBeOnTheScreen();
  });

  it('keeps the figures row away when no source gave one, and says a speculative premise in words', async () => {
    await show(card({ answer: { ...answer, numbers: [] }, speculative: true, status: 'ready', content: scroll }));
    expect(screen.queryByLabelText('Figures')).toBeNull();
    expect(screen.getByText('Speculative scenario · not established science')).toBeOnTheScreen();
  });

  it('says "Opened by you" only as the caller’s own history, and offers Remove to the starter in ⋯', async () => {
    const { remove } = await show(card({ answer, status: 'ready', content: scroll }), {
      starterIsYou: true,
      openedByYou: true,
    });
    expect(screen.getByText('Opened by you')).toBeOnTheScreen();
    expect(screen.getByText('FROM THE THREAD · ASKED BY YOU · CHECKED')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'More about this branch' }));
    await fireEvent.press(screen.getByText('Remove'));
    expect(remove).toHaveBeenCalledTimes(1);
    // Branch again is on the card, so the menu does not repeat it.
    expect(screen.queryAllByText('What if…')).toHaveLength(0);
  });
});

describe('a what-if that gets no short answer, and a perspective', () => {
  it('shows the branch card it always was, with a plain line that there is no short answer', async () => {
    await show(card({ answer: { status: 'unavailable' } }));
    expect(screen.getByTestId('no-short-answer')).toHaveTextContent('No short answer this time.');
    expect(screen.getByText('Preparing the first Scroll')).toBeOnTheScreen();
    expect(screen.queryByText('What-if · made by KnowScroll')).toBeNull();
  });

  it('keeps a branch made before short answers existed, and a perspective, exactly as they were', async () => {
    await show(card());
    expect(screen.getByText('Preparing the first Scroll')).toBeOnTheScreen();
    expect(screen.queryByTestId('no-short-answer')).toBeNull();
    expect(screen.queryByTestId('what-if-card')).toBeNull();
  });
});
