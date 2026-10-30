import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { EpisodeList } from './episode-list';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const episode = (n: number, patch: Partial<ThreadEpisode> = {}): ThreadEpisode => ({
  assetId: id(n),
  assetRevision: 1,
  kind: n === 1 ? 'reel' : 'scroll',
  part: n,
  title: ['', 'The edge', 'Time slows', 'Forever?'][n] ?? 'More',
  state: 'ready',
  visited: false,
  ...patch,
});

async function show(selected = id(2)) {
  const onSelect = jest.fn();
  const onStep = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <EpisodeList
        episodes={[episode(1, { visited: true }), episode(2), episode(3, { state: 'corrected' })]}
        selected={selected}
        series
        onSelect={onSelect}
        onStep={onStep}
      />
    </DisplayProvider>,
  );
  return { onSelect, onStep };
}

describe('the episode list', () => {
  it('names each episode with its place, title and own state in words', async () => {
    await show();
    expect(screen.getByRole('button', { name: 'Part 1, The edge, visited by you' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 2, Time slows, selected' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 3, Forever?, updated' })).toBeOnTheScreen();
  });

  it('marks the selected row Now and the corrected one Updated', async () => {
    await show();
    expect(screen.getByText('Now')).toBeOnTheScreen();
    expect(screen.getByText('Updated')).toBeOnTheScreen();
  });

  it('selects the episode that is pressed, whatever its state', async () => {
    const { onSelect, onStep } = await show();
    await fireEvent.press(screen.getByRole('button', { name: 'Part 3, Forever?, updated' }));
    expect(onSelect).toHaveBeenCalledWith(id(3));
    expect(onStep).not.toHaveBeenCalled();
  });

  it('steps with the arrow keys, down and right to the next and up and left to the one before, never past the ends, and never chooses', async () => {
    const { onSelect, onStep } = await show();
    const list = screen.getByTestId('episode-navigator');
    const press = (key: string) => fireEvent(list, 'keyDown', { key, preventDefault: jest.fn() });
    await press('ArrowDown');
    expect(onStep).toHaveBeenLastCalledWith(id(3));
    await press('ArrowRight');
    expect(onStep).toHaveBeenLastCalledWith(id(3));
    await press('ArrowUp');
    expect(onStep).toHaveBeenLastCalledWith(id(1));
    await press('ArrowLeft');
    expect(onStep).toHaveBeenLastCalledWith(id(1));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('leaves the browser’s own arrow shortcuts alone', async () => {
    const { onStep } = await show();
    await fireEvent(screen.getByTestId('episode-navigator'), 'keyDown', {
      key: 'ArrowRight',
      altKey: true,
      preventDefault: jest.fn(),
    });
    expect(onStep).not.toHaveBeenCalled();
  });
});
