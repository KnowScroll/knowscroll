import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ScenarioCard } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { BranchCard, branchLabel } from './branch-card';

const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const asha = {
  kind: 'person' as const,
  personId: '0199a000-0000-7000-8000-00000000000a',
  handle: 'ci.asha',
  displayName: 'Asha',
};
const card = (patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: '0199a000-0000-7000-8000-000000000009',
  kind: 'what_if',
  origin: 'root',
  title: 'What happens at ten times the traffic?',
  changes: [traffic],
  kept: [model],
  hypothetical: true,
  speculative: false,
  assumptions: [traffic],
  startedBy: asha,
  status: 'preparing',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  ...patch,
});

async function show(value: ScenarioCard, starterIsYou = false, openedByYou = false) {
  const open = jest.fn();
  const remove = jest.fn();
  const next = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <BranchCard
        card={value}
        starterIsYou={starterIsYou}
        startedLine="from the thread"
        openedByYou={openedByYou}
        onOpen={open}
        onRemove={remove}
        onContinue={next}
      />
    </DisplayProvider>,
  );
  return { open, remove, next };
}

describe('a branch card', () => {
  it('says plainly that a what-if is preparing, with its premise, and offers nothing to open yet', async () => {
    await show(card());
    expect(
      screen.getByLabelText(/What if, hypothetical: What happens at ten times the traffic\?, preparing/),
    ).toBeOnTheScreen();
    expect(screen.getByText('Hypothetical')).toBeOnTheScreen();
    expect(screen.getByText('Preparing the first Scroll')).toBeOnTheScreen();
    expect(screen.getByText('Changed: traffic is ten times higher than in the original')).toBeOnTheScreen();
    expect(screen.getByText('Kept: the same model serves every request')).toBeOnTheScreen();
    expect(screen.getByText('Asked by Asha · from the thread')).toBeOnTheScreen();
    expect(screen.queryByText('Explore this')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('offers to explore a ready branch, and to ask What if from it, and nothing about anyone’s position', async () => {
    const { open, next } = await show(
      card({
        status: 'ready',
        content: {
          kind: 'scroll',
          assetId: '0199a000-0000-7000-8000-0000000000aa',
          assetRevision: 1,
          title: 'A Scroll',
        },
      }),
    );
    await fireEvent.press(screen.getByText('Explore this'));
    expect(open).toHaveBeenCalledTimes(1);
    // What if… is beside the card, not on it.
    expect(screen.queryByText('What if…')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'More about this branch' }));
    await fireEvent.press(screen.getByText('What if…'));
    expect(next).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/watching|current|seen/i)).toBeNull();
  });

  it('keeps Remove off the card of a ready branch: in ⋯, and only for the one who asked', async () => {
    const ready = card({
      status: 'ready',
      content: { kind: 'scroll', assetId: '0199a000-0000-7000-8000-0000000000aa', assetRevision: 1, title: 'A Scroll' },
    });
    await show(ready);
    expect(screen.queryByText('Remove')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'More about this branch' }));
    expect(screen.queryByText('Remove')).toBeNull();
    await screen.unmount();
    const mine = await show(ready, true);
    expect(screen.queryByText('Remove')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'More about this branch' }));
    await fireEvent.press(screen.getByText('Remove'));
    expect(mine.remove).toHaveBeenCalledTimes(1);
  });

  it('says Opened by you only when the member did, and never that anyone else did', async () => {
    const ready = card({
      status: 'ready',
      content: { kind: 'scroll', assetId: '0199a000-0000-7000-8000-0000000000aa', assetRevision: 1, title: 'A Scroll' },
    });
    await show(ready);
    expect(screen.queryByText(/Opened/)).toBeNull();
    await screen.unmount();
    await show(ready, false, true);
    expect(screen.getByText('Opened by you')).toBeOnTheScreen();
    expect(screen.queryByText(/Opened by (?!you)/)).toBeNull();
  });

  it('says honestly when it could not be prepared, and lets only the one who asked remove it', async () => {
    const view = await show(card({ status: 'failed' }));
    expect(screen.getByText('Couldn’t prepare this branch')).toBeOnTheScreen();
    expect(screen.queryByText('Remove')).toBeNull();
    await screen.unmount();
    const mine = await show(card({ status: 'failed' }), true);
    expect(screen.getByText('Asked by you · from the thread')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Remove'));
    expect(mine.remove).toHaveBeenCalledTimes(1);
    void view;
  });

  it('lets the one who asked remove a branch that is still preparing, from the card', async () => {
    const mine = await show(card(), true);
    await fireEvent.press(screen.getByText('Remove'));
    expect(mine.remove).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await show(card());
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('draws another perspective with its lens and no hypothetical label unless it inherits one', async () => {
    await show(
      card({ kind: 'perspective', hypothetical: false, changes: [], kept: [], lens: 'the view of the person on call' }),
    );
    expect(screen.getByText('ANOTHER PERSPECTIVE')).toBeOnTheScreen();
    expect(screen.getByText('Through the lens of the view of the person on call')).toBeOnTheScreen();
    expect(screen.queryByText('Hypothetical')).toBeNull();
    await screen.unmount();
    await show(card({ kind: 'perspective', hypothetical: true, changes: [], lens: 'cost' }));
    expect(screen.getByText('Hypothetical')).toBeOnTheScreen();
  });

  it('is a quiet note when removed', async () => {
    await show(card({ status: 'removed' }));
    expect(screen.getByText('A branch was removed · nothing else changed')).toBeOnTheScreen();
    expect(screen.queryByText('Explore this')).toBeNull();
    expect(branchLabel(card({ status: 'removed' }))).toContain('removed');
  });

  it('tags a speculative what-if Speculative, in place of Hypothetical, and says the premise in words', async () => {
    await show(card({ speculative: true }));
    expect(screen.getByText('Speculative scenario · not established science')).toBeOnTheScreen();
    expect(screen.getByText('Speculative')).toBeOnTheScreen();
    expect(screen.queryByText('Hypothetical')).toBeNull();
  });

  it('says nothing of speculation for an ordinary what-if', async () => {
    await show(card());
    expect(screen.queryByText(/not established science/)).toBeNull();
  });
});
