import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ThreadEpisode } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { EpisodeNavigator, episodeLabel } from './episode-navigator';

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

async function show(props: Partial<Parameters<typeof EpisodeNavigator>[0]> = {}) {
  const onSelect = jest.fn();
  const episodes = props.episodes ?? [episode(1, { visited: true }), episode(2), episode(3, { state: 'corrected' })];
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <EpisodeNavigator episodes={episodes} selected={id(2)} series folded={false} onSelect={onSelect} {...props} />
    </DisplayProvider>,
  );
  return onSelect;
}

describe('the episode navigator', () => {
  it('names each episode with its place, title and own state in words', async () => {
    await show();
    expect(screen.getByRole('button', { name: 'Part 1, The edge, visited by you' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 2, Time slows, selected' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 3, Forever?, updated' })).toBeOnTheScreen();
  });

  it('selects the episode that is pressed, whatever its state', async () => {
    const onSelect = await show();
    await fireEvent.press(screen.getByRole('button', { name: 'Part 3, Forever?, updated' }));
    expect(onSelect).toHaveBeenCalledWith(id(3));
  });

  it('shows numbered chips when the player is folded', async () => {
    await show({ folded: true });
    expect(screen.getByRole('button', { name: 'Part 1, The edge, visited by you' })).toBeOnTheScreen();
    expect(screen.getByText('2 · now')).toBeOnTheScreen();
  });

  it('labels an episode that is gone without hiding it', async () => {
    expect(episodeLabel(episode(2, { state: 'unavailable' }), false, true)).toBe(
      'Part 2, Time slows, no longer available',
    );
  });

  it('calls a single item by its format, not by a part number', async () => {
    expect(episodeLabel({ ...episode(1), part: undefined }, true, false)).toBe('Reel, The edge, selected');
    expect(episodeLabel({ ...episode(2), part: undefined }, false, false)).toBe('Scroll, Time slows');
  });
});
