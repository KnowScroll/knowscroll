import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ThreadEpisode, ThreadParticipant, ThreadPlace } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { EpisodeList } from './episode-list';
import { MembersSection, PartFaces, PartWorlds, PartyLine, SeriesTabs, partPlacesWords } from './party';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const asha = person(10, 'Asha');
const ravi = person(11, 'Ravi');
const kenji = person(12, 'Kenji');
const episode = (n: number): ThreadEpisode => ({
  assetId: id(300 + n),
  assetRevision: 1,
  kind: 'scroll',
  part: n,
  title: `Part title ${String(n)}`,
  state: 'ready',
  visited: false,
});
const episodes = [episode(1), episode(2), episode(3)];
const place = (who: typeof asha, part: number, state: 'on' | 'finished', you = false): ThreadPlace => ({
  person: who,
  you,
  part,
  state,
  day: '2026-10-24',
});
const party = [place(ravi, 2, 'on'), place(kenji, 1, 'finished'), place(asha, 1, 'on', true)];

const inDisplay = (node: React.ReactElement) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>
);

describe('the part worlds in the header', () => {
  it('draws a world per part, with the faces of the members who share on the part they are on', async () => {
    await render(inDisplay(<PartWorlds episodes={episodes} places={party} selected={episodes[1]!.assetId} />));
    expect(screen.getAllByTestId(/^part-world-/)).toHaveLength(3);
    // Faces are decorative (each world's accessible name says who is on it), so they are hidden from readers.
    const face = (who: typeof asha) => screen.getByTestId(`face-${who.personId}`, { includeHiddenElements: true });
    expect(face(ravi)).toBeOnTheScreen();
    expect(face(kenji)).toBeOnTheScreen();
    expect(face(asha)).toBeOnTheScreen();
  });

  it('names each world for a screen reader with who is on it or finished it, never watching', async () => {
    await render(inDisplay(<PartWorlds episodes={episodes} places={party} selected={undefined} />));
    expect(screen.getByLabelText('Part 1. You are on it. Kenji finished it')).toBeOnTheScreen();
    expect(screen.getByLabelText('Part 2. Ravi is on it')).toBeOnTheScreen();
    expect(screen.getByLabelText('Part 3')).toBeOnTheScreen();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/watching/i);
  });

  it('shows plain worlds when nobody shares a place, and a count when there are more parts than room', async () => {
    const many = Array.from({ length: 8 }, (_, index) => episode(index + 1));
    await render(inDisplay(<PartWorlds episodes={many} places={[]} selected={undefined} />));
    expect(screen.getAllByTestId(/^part-world-/)).toHaveLength(6);
    expect(screen.getByText('+2')).toBeOnTheScreen();
    expect(screen.queryByTestId('part-faces')).toBeNull();
  });
});

describe('the party line', () => {
  it('says where the others are, as T3 draws it', async () => {
    await render(inDisplay(<PartyLine places={party} total={3} />));
    expect(screen.getByText('Ravi is on Part 2 · Kenji finished Part 1')).toBeOnTheScreen();
  });

  it('says "All finished" when everyone who shares finished the last part', async () => {
    await render(inDisplay(<PartyLine places={[place(ravi, 3, 'finished'), place(kenji, 3, 'finished')]} total={3} />));
    expect(screen.getByText('All finished')).toBeOnTheScreen();
  });

  it('is absent when nobody else shows a place', async () => {
    await render(inDisplay(<PartyLine places={[place(asha, 2, 'on', true)]} total={3} />));
    expect(screen.queryByTestId('party-line')).toBeNull();
  });
});

describe('faces on a part row', () => {
  it('says who is on a part and who finished it, in faces and in words', async () => {
    await render(inDisplay(<PartFaces faces={[place(ravi, 2, 'on'), place(kenji, 2, 'finished')]} />));
    // The faces are decorative: the row's accessible name carries the words.
    expect(screen.getByText('Ravi on it · Kenji finished', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(partPlacesWords([place(asha, 1, 'on', true)])).toBe('You are on it.');
    expect(partPlacesWords(undefined)).toBeUndefined();
  });

  it('puts the faces on the rows of the Series list and in their accessible names', async () => {
    await render(
      inDisplay(
        <EpisodeList
          episodes={episodes}
          selected={episodes[0]!.assetId}
          series
          places={party}
          onSelect={jest.fn()}
          onStep={jest.fn()}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /^Part 2, Part title 2\. Ravi is on it\.$/ })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: /^Part 1, Part title 1, selected\. You are on it\. Kenji finished it\.$/ }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 3, Part title 3' })).toBeOnTheScreen();
  });
});

describe('the members and "hide where I am"', () => {
  const participants: ThreadParticipant[] = [
    { person: asha, role: 'starter', joined: true, you: true },
    { person: ravi, role: 'member', joined: true, you: false },
    { person: kenji, role: 'member', joined: false, you: false },
  ];
  const show = async (hidden = false, saving = false, places: ThreadPlace[] = party) => {
    const onHide = jest.fn();
    await render(
      inDisplay(
        <MembersSection
          participants={participants}
          places={places}
          total={3}
          now={new Date('2026-10-31T10:00:00Z')}
          state={{ hidden, saving, phase: 'ready' }}
          onHide={onHide}
        />,
      ),
    );
    return onHide;
  };

  it('lists each member with where they are and the day, and the handle when they show none', async () => {
    await show(false, false, [place(ravi, 2, 'on'), place(asha, 1, 'finished', true)]);
    expect(screen.getByText('Asha (you)')).toBeOnTheScreen();
    expect(screen.getByText('Finished Part 1 · Sat 24 Oct')).toBeOnTheScreen();
    expect(screen.getByText('On Part 2 · Sat 24 Oct')).toBeOnTheScreen();
    // Kenji shows none: only the handle, and nothing says why.
    expect(screen.getByText('@ci.kenji')).toBeOnTheScreen();
    expect(screen.getByText('Started it')).toBeOnTheScreen();
    expect(screen.getByText('Invited')).toBeOnTheScreen();
  });

  it('shows no time of day and never says watching', async () => {
    await show();
    const text = JSON.stringify(screen.toJSON());
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/watching/i);
  });

  it('offers the switch off by default, and hides when it is pressed', async () => {
    const onHide = await show();
    const hide = screen.getByRole('switch', { name: 'Hide where I am' });
    expect(hide.props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByText(/People in this thread see which part you are on, and the day\./)).toBeOnTheScreen();
    await fireEvent.press(hide);
    expect(onHide).toHaveBeenCalledWith(true);
  });

  it('says it is hidden when it is, and shows again when it is pressed', async () => {
    const onHide = await show(true);
    expect(screen.getByRole('switch', { name: 'Hide where I am' }).props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByText('Hidden. Nobody in this thread sees which part you are on.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('switch', { name: 'Hide where I am' }));
    expect(onHide).toHaveBeenCalledWith(false);
  });

  it('cannot be pressed while a change is on its way', async () => {
    const onHide = await show(false, true);
    await fireEvent.press(screen.getByRole('switch', { name: 'Hide where I am' }));
    expect(onHide).not.toHaveBeenCalled();
  });
});

describe('the Series tabs', () => {
  it('shows Parts and Members with their count, and chooses one', async () => {
    const onTab = jest.fn();
    await render(inDisplay(<SeriesTabs tab="parts" onTab={onTab} memberCount={4} />));
    expect(screen.getByRole('tab', { name: 'Parts' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole('tab', { name: 'Members 4' }).props.accessibilityState).toMatchObject({ selected: false });
    await fireEvent.press(screen.getByRole('tab', { name: 'Members 4' }));
    expect(onTab).toHaveBeenCalledWith('members');
  });
});
