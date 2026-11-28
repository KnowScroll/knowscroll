import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { DisplayProvider } from '@knowscroll/ui';
import { UniverseHeader } from './universe-header';
import type { UniverseView } from './universe-layout';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));
jest.mock('../../providers/account-scope', () => ({ useAccountInitial: () => 'F' }));

const place = (objectId: string, label: string) => ({ objectId, label, parentId: '' }) as unknown as SceneDescriptor;
const system = place('s1', 'CI system 0');
const planet = place('p1', 'CI planet 2');
const session = { places: () => [], up: jest.fn(), focus: jest.fn() } as unknown as UniverseMapSession;
const state = { lately: false, absent: false } as UniverseViewState;

const views: readonly (readonly [string, UniverseView])[] = [
  ['a star', { kind: 'system', system }],
  ['a planet’s globe', { kind: 'planet', planet, landed: false }],
  ['a planet’s ground', { kind: 'planet', planet, landed: true }],
];

async function header(
  view: UniverseView,
  extra: {
    voyage?: boolean;
    desktop?: boolean;
    visitor?: boolean;
    outer?: { line: string; onLeave: () => void };
  } = {},
) {
  const onSearch = jest.fn();
  await render(
    <DisplayProvider value={{ width: extra.desktop ? 1280 : 390, textScale: 1, reducedMotion: true }}>
      <UniverseHeader
        session={session}
        state={state}
        view={view}
        hasPlaces
        onSearch={onSearch}
        {...(extra.voyage ? { voyage: true } : {})}
        {...(extra.desktop ? { desktop: true } : {})}
        {...(extra.visitor ? { visitor: { ownerName: 'Ada' } } : {})}
        {...(extra.outer ? { outer: extra.outer } : {})}
      />
    </DisplayProvider>,
  );
  return onSearch;
}

describe('search from every stop in the new look', () => {
  it.each(views)('has a named search circle at %s that opens search', async (_name, view) => {
    const onSearch = await header(view, { voyage: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Search your universe' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('is a 48 px target (the prototype draws 44; the web has no touch slop to make up the rest)', async () => {
    await header(views[0]![1], { voyage: true });
    const circle = screen.getByRole('button', { name: 'Search your universe' });
    expect(circle).toHaveStyle({ width: 48, height: 48 });
  });

  it('names a friend’s universe on a visit', async () => {
    await header(views[0]![1], { voyage: true, visitor: true });
    expect(screen.getByRole('button', { name: 'Search Ada’s universe' })).toBeOnTheScreen();
  });

  it.each(views)('is not there at %s with the new look off, as today', async (_name, view) => {
    await header(view);
    expect(screen.queryByRole('button', { name: /^Search / })).toBeNull();
  });

  it('is not there on the desktop, where Browse carries search', async () => {
    await header(views[0]![1], { voyage: true, desktop: true });
    expect(screen.queryByRole('button', { name: /^Search / })).toBeNull();
  });
});

describe('the outer stop', () => {
  const universe: UniverseView = { kind: 'universe' };

  it('says “Beyond your universe”, the line under it, and has a Back pill named for where it goes', async () => {
    const onLeave = jest.fn();
    await header(universe, { voyage: true, outer: { line: '14 friends', onLeave } });
    expect(screen.getByRole('header', { name: 'Beyond your universe' })).toBeOnTheScreen();
    expect(screen.getByTestId('outer-line').props.children).toBe('14 friends');
    const pill = screen.getByTestId('universe-up');
    expect(pill).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Your universe' })).toBeOnTheScreen();
    await fireEvent.press(pill);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('has no title of the universe’s own, and no search, as the screen with it is only the way back', async () => {
    await header(universe, { voyage: true, outer: { line: '2 friends', onLeave: jest.fn() } });
    expect(screen.queryByRole('header', { name: 'Your universe' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Search / })).toBeNull();
  });

  it('is as it always was at the whole universe without it, and never on a friend’s universe', async () => {
    await header(universe, { voyage: true });
    expect(screen.getByRole('header', { name: 'Your universe' })).toBeOnTheScreen();
    expect(screen.queryByTestId('universe-up')).toBeNull();
    await screen.unmount();
    await header(universe, { voyage: true, visitor: true, outer: { line: '2 friends', onLeave: jest.fn() } });
    expect(screen.queryByText('Beyond your universe')).toBeNull();
  });

  it('is not drawn at a star, whatever it is handed', async () => {
    await header(views[0]![1], { voyage: true, outer: { line: '2 friends', onLeave: jest.fn() } });
    expect(screen.queryByText('Beyond your universe')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to Universe' })).toBeOnTheScreen();
  });
});

describe('the Lately chip’s fill', () => {
  it.each([
    [true, 'rgba(10,20,28,0.55)'],
    [false, undefined],
  ])(
    'with the new look %s, the chip while Lately is off has the glass fill only in the new look',
    async (voyage, fill) => {
      await header({ kind: 'universe' }, voyage ? { voyage: true } : {});
      const chip = screen.getByTestId('universe-lately');
      if (fill) expect(chip).toHaveStyle({ backgroundColor: fill });
      else expect(chip).not.toHaveStyle({ backgroundColor: 'rgba(10,20,28,0.55)' });
    },
  );
});
