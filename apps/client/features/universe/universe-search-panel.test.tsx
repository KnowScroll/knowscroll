import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { UniverseSearchPanel } from './universe-search-panel';
import type { UniversePlace, UniverseMapSession } from './universe-session';

const place = (id: string, kind: UniversePlace['kind'], label: string, parentId = ''): UniversePlace => ({
  id,
  kind,
  label,
  parentId,
  truthStatus: 'factual',
});
const places = [
  place('s1', 'system', 'Machine learning'),
  place('p1', 'planet', 'Inference', 's1'),
  place('s2', 'system', 'Economics'),
];
const fakeSession = () => ({ places: () => places, back: jest.fn(), focus: jest.fn() });

async function open(
  session: ReturnType<typeof fakeSession>,
  extra: Partial<Parameters<typeof UniverseSearchPanel>[0]>,
) {
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <UniverseSearchPanel session={session as unknown as UniverseMapSession} {...extra} />
    </DisplayProvider>,
  );
  return screen.getByLabelText('Search your universe');
}

describe('the search card tells the sky which systems hold a match', () => {
  it('says nothing is lit while nothing is typed, then the systems of what is typed, and nothing when it goes', async () => {
    const onLit = jest.fn();
    const field = await open(fakeSession(), { onLit });
    expect(onLit).toHaveBeenLastCalledWith(null);

    await fireEvent.changeText(field, 'inference');
    expect(onLit).toHaveBeenLastCalledWith(['s1']);
    await fireEvent.changeText(field, 'e');
    // Best match first: a name that starts with the letter lights its system before names that only hold it.
    expect(onLit).toHaveBeenLastCalledWith(['s2', 's1']);
    await fireEvent.changeText(field, 'zzz');
    expect(onLit).toHaveBeenLastCalledWith([]);
    await fireEvent.changeText(field, '');
    expect(onLit).toHaveBeenLastCalledWith(null);
  });

  it('says nothing is lit once it unmounts', async () => {
    const onLit = jest.fn();
    await open(fakeSession(), { onLit });
    await screen.unmount();
    expect(onLit).toHaveBeenLastCalledWith(null);
  });
});

describe('Escape typed in the field', () => {
  it('closes the card when asked to (the new look), and is left alone otherwise', async () => {
    const asked = fakeSession();
    await fireEvent(await open(asked, { closeOnEscape: true }), 'keyPress', {
      nativeEvent: { key: 'Escape' },
      preventDefault: jest.fn(),
    });
    expect(asked.back).toHaveBeenCalledTimes(1);

    await screen.unmount();
    const unasked = fakeSession();
    await fireEvent(await open(unasked, {}), 'keyPress', { nativeEvent: { key: 'Escape' }, preventDefault: jest.fn() });
    expect(unasked.back).not.toHaveBeenCalled();
  });
});
