import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { BranchNavigator, SpeculativeBanner, TryAnotherPrompt, branchSubtitle } from './branch-chrome';

const wrap = (node: React.ReactNode) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>
);

describe('the branch navigator', () => {
  it('names where the way back goes, and shows the branch as its one current item', async () => {
    const onReturn = jest.fn();
    await render(
      wrap(
        <BranchNavigator
          returnLabel="Part 2"
          returnSpoken="Back to Black holes, Part 2"
          item="current"
          onReturn={onReturn}
        />,
      ),
    );
    expect(screen.getByText('Part 2')).toBeOnTheScreen();
    expect(screen.getByLabelText('Item 1, current')).toBeOnTheScreen();
    expect(screen.queryByText(/2 ·/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Black holes, Part 2' }));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});

describe('a branch whose Scroll is not there yet', () => {
  it('says its one item is being prepared, and shows no item at all when there is none', async () => {
    const view = (item: 'current' | 'preparing' | undefined) => (
      <BranchNavigator returnLabel="Black holes" returnSpoken="Back to Black holes" item={item} onReturn={jest.fn()} />
    );
    const { rerender } = await render(wrap(view('preparing')));
    expect(screen.getByLabelText('Item 1, preparing')).toBeOnTheScreen();
    expect(screen.queryByText('1 · current')).toBeNull();
    await rerender(wrap(view(undefined)));
    expect(screen.queryByLabelText(/^Item 1/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to Black holes' })).toBeOnTheScreen();
  });
});

describe('the speculative banner', () => {
  it('says it in words as the premise’s own text, with no second status label', async () => {
    await render(wrap(<SpeculativeBanner />));
    expect(screen.getByText('Speculative scenario · not established science')).toBeOnTheScreen();
    expect(screen.queryByText('Speculative')).toBeNull();
  });
});

describe('the line under a branch’s thread title', () => {
  it('names the kind and the idea', () => {
    expect(branchSubtitle({ kind: 'what_if', title: 'a black hole were a portal' })).toBe(
      'What if · a black hole were a portal',
    );
    expect(branchSubtitle({ kind: 'perspective', title: 'The physicist’s view' })).toBe(
      'Another perspective · The physicist’s view',
    );
    expect(branchSubtitle({ kind: 'what_if', title: 'What if it spun faster?' })).toBe('What if it spun faster?');
  });
});

describe('trying another assumption', () => {
  it('offers Continue only for words, hands them over trimmed, and can be put away', async () => {
    const onContinue = jest.fn();
    const onDismiss = jest.fn();
    await render(wrap(<TryAnotherPrompt onContinue={onContinue} onDismiss={onDismiss} />));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Try another assumption'), '  What if it spun faster?  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledWith('What if it spun faster?');
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
