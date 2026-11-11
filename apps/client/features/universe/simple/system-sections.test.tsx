import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ListedSystem, ListedUniverse } from '../universe-lists';
import type { UniverseMapSession } from '../universe-session';
import { LISTED_SYSTEM_LIMIT, SystemSections } from './system-sections';

const system = (n: number, loaded: boolean): ListedSystem => ({
  id: `system-${n}`,
  name: `System ${n}`,
  planets: loaded
    ? [{ id: `planet-${n}`, name: `Planet ${n}`, regions: 0, hereRegion: undefined, quiet: false, hypothetical: false }]
    : [],
  planetCount: 3,
  loaded,
  rooms: [],
  quiet: false,
  hypothetical: false,
});
const sessionOf = () => {
  const focus = jest.fn(() => true);
  return { focus, session: { focus, showFinds: jest.fn() } as unknown as UniverseMapSession };
};

describe('the plain lists of a map of thousands of systems (D-417)', () => {
  it('list the first systems, say how many there are and point to search for the rest', async () => {
    const listed: ListedUniverse = { systems: Array.from({ length: 3000 }, (_, n) => system(n, false)), rooms: [] };
    await render(<SystemSections session={sessionOf().session} listed={listed} />);
    expect(screen.getAllByTestId(/^simple-system-system-/)).toHaveLength(LISTED_SYSTEM_LIMIT);
    expect(screen.getByTestId('simple-systems-more')).toHaveTextContent(
      `Showing ${LISTED_SYSTEM_LIMIT} of 3000 systems. Search to find the rest.`,
    );
  });

  it('list every system of a map that fits, with no note', async () => {
    const listed: ListedUniverse = { systems: Array.from({ length: 5 }, (_, n) => system(n, true)), rooms: [] };
    await render(<SystemSections session={sessionOf().session} listed={listed} />);
    expect(screen.getAllByTestId(/^simple-system-system-/)).toHaveLength(5);
    expect(screen.queryByTestId('simple-systems-more')).toBeNull();
  });

  it('count the planets of a system that is not loaded, and open it to load them', async () => {
    const { focus, session } = sessionOf();
    const listed: ListedUniverse = { systems: [system(1, false), system(2, true)], rooms: [] };
    await render(<SystemSections session={session} listed={listed} />);
    // Both say three planets, whether or not they are in hand.
    expect(screen.getAllByText('3 planets')).toHaveLength(3);
    expect(screen.queryByTestId('simple-system-open-system-2')).toBeNull();
    await fireEvent.press(screen.getByTestId('simple-system-open-system-1'));
    expect(focus).toHaveBeenCalledWith('system-1');
  });
});
