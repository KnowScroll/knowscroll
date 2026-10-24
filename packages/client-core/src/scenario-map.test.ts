import { describe, expect, it } from 'vitest';
import type { ScenarioCard, ScenarioSuggestion, ThreadEpisode } from '@knowscroll/contracts';
import type { ScopedStorage } from './account-scope';
import {
  DEFAULT_MAP_PREFERENCES,
  GROUP_LIMIT,
  buildMap,
  loadHere,
  loadMapPreferences,
  mapOffered,
  returnTarget,
  saveHere,
  saveMapPreferences,
  type MapPreferences,
  type MapRow,
} from './scenario-map';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const me = id(90);
const them = id(91);
const person = (personId: string, name: string) => ({
  kind: 'person' as const,
  personId,
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const episodes: ThreadEpisode[] = [1, 2, 3, 4].map((part) => ({
  assetId: id(part),
  assetRevision: 1,
  kind: 'scroll',
  part,
  title: `Part ${String(part)} title`,
  state: 'ready',
  visited: part === 1,
}));
const rootAssetId = id(2);
const card = (n: number, patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: id(100 + n),
  kind: 'what_if',
  origin: 'root',
  title: `Branch ${String(n)}`,
  changes: [],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [],
  startedBy: person(me, 'Asha'),
  status: 'ready',
  revision: 1,
  createdAt: `2026-10-24T10:0${String(n)}:00.000Z`,
  ...patch,
});
const suggestion = (n: number, patch: Partial<ScenarioSuggestion> = {}): ScenarioSuggestion => ({
  draftId: id(200 + n),
  optionId: 'o1',
  kind: 'what_if',
  title: `Suggestion ${String(n)}`,
  speculative: false,
  ...patch,
});
const view = (
  cards: ScenarioCard[],
  suggestions: ScenarioSuggestion[] = [],
  patch: Partial<Parameters<typeof buildMap>[0]> = {},
) =>
  buildMap({
    threadTitle: 'Black holes',
    episodes,
    rootAssetId,
    cards,
    suggestions,
    ownPersonId: me,
    here: { kind: 'original' },
    selectedAssetId: id(2),
    preferences: DEFAULT_MAP_PREFERENCES,
    query: '',
    ...patch,
  });
const titles = (rows: readonly MapRow[]) =>
  rows.map((row) => `${'.'.repeat(row.depth)}${'title' in row ? row.title : 'more'}`);

describe('when a thread is offered a map', () => {
  it('is after several branches stand, never for the first exploration, and a removed one does not count', () => {
    expect(mapOffered([])).toBe(false);
    expect(mapOffered([card(1)])).toBe(false);
    expect(mapOffered([card(1), card(2)])).toBe(true);
    expect(mapOffered([card(1), card(2, { status: 'removed' })])).toBe(false);
    expect(mapOffered([card(1, { status: 'preparing' }), card(2, { kind: 'perspective' })])).toBe(true);
  });
});

describe('the outline of a thread', () => {
  it('lists the original sequence and nests the branches under the episode they grew from, in the order they were made', () => {
    const rows = view([card(1), card(2, { parentNodeId: id(101) }), card(3)]).rows;
    expect(titles(rows)).toEqual([
      'Part 1 title',
      'Part 2 title',
      '.Branch 1',
      '..Branch 2',
      '.Branch 3',
      'Part 3 title',
      'Part 4 title',
    ]);
  });

  it('says what each branch is: ready, preparing, failed, perspective, speculative, and Removed with no title', () => {
    const rows = view(
      [
        card(1, { speculative: true }),
        card(2, { kind: 'perspective', hypothetical: false }),
        card(3, { status: 'preparing' }),
        card(4, { status: 'failed' }),
        card(5, { status: 'removed', title: 'A private premise' }),
      ],
      [],
      { preferences: { filter: 'everyone', expanded: ['root'] } },
    ).rows.filter((row) => row.kind === 'branch');
    expect(
      rows.map((row) => row.kind === 'branch' && [row.status, row.branchKind, row.speculative, row.openable]),
    ).toEqual([
      ['ready', 'what_if', true, true],
      ['ready', 'perspective', false, true],
      ['preparing', 'what_if', false, false],
      ['failed', 'what_if', false, false],
      ['removed', 'what_if', false, false],
    ]);
    expect(titles(rows)).toContain('.Removed');
    expect(JSON.stringify(rows)).not.toContain('A private premise');
  });

  it('shows an unmade suggestion under what it would continue, with no number, and nothing else to open', () => {
    const rows = view([card(1)], [suggestion(1), suggestion(2, { parentNodeId: id(101), speculative: true })]).rows;
    expect(titles(rows)).toContain('.Suggestion 1');
    expect(titles(rows)).toContain('..Suggestion 2');
    const shown = rows.find((row) => row.kind === 'suggestion');
    expect(shown).toBeDefined();
    expect(shown).not.toHaveProperty('part');
    expect(shown).not.toHaveProperty('nodeId');
  });

  it('marks only the member’s own position: the selected episode in the original, or the branch they are in', () => {
    const inOriginal = view([card(1)], [], { selectedAssetId: id(3) }).rows.filter((row) => 'here' in row && row.here);
    expect(inOriginal.map((row) => row.key)).toEqual([`episode:${id(3)}`]);
    const inBranch = view([card(1), card(2)], [], { here: { kind: 'branch', nodeId: id(102) } }).rows.filter(
      (row) => 'here' in row && row.here,
    );
    expect(inBranch.map((row) => row.key)).toEqual([id(102)]);
  });

  it('marks a branch as the member’s own only when they started it', () => {
    const rows = view([card(1), card(2, { startedBy: person(them, 'Ravi') }), card(3, { startedBy: undefined })]).rows;
    expect(rows.filter((row) => row.kind === 'branch').map((row) => row.kind === 'branch' && row.mine)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe('the filter and the search', () => {
  const cards = [
    card(1, { startedBy: person(them, 'Ravi'), title: 'Ravi’s idea' }),
    card(2, { parentNodeId: id(101), title: 'Asha builds on it' }),
    card(3, { startedBy: person(them, 'Ravi'), title: 'Another of Ravi’s' }),
  ];
  const withPreferences = (preferences: Partial<MapPreferences>) => ({
    preferences: { ...DEFAULT_MAP_PREFERENCES, ...preferences },
  });

  it('keeps mine, and the path to it so it still reads in place', () => {
    const mine = view(cards, [], withPreferences({ filter: 'mine' })).rows.filter((row) => row.kind === 'branch');
    expect(mine.map((row) => row.key)).toEqual([id(101), id(102)]);
  });

  it('shows everyone’s branches and the member’s suggestions together, and suggestions alone on request', () => {
    const everyone = view(cards, [suggestion(1)]).rows;
    expect(everyone.filter((row) => row.kind === 'branch')).toHaveLength(3);
    expect(everyone.filter((row) => row.kind === 'suggestion')).toHaveLength(1);
    const only = view(cards, [suggestion(1)], withPreferences({ filter: 'suggestions' })).rows;
    expect(only.filter((row) => row.kind === 'branch')).toEqual([]);
    expect(only.filter((row) => row.kind === 'suggestion')).toHaveLength(1);
  });

  it('finds a branch by its words, never by a removed title, and says when nothing matches', () => {
    const found = view(cards, [], { query: 'ravi' });
    expect(found.rows.filter((row) => row.kind === 'branch').map((row) => row.key)).toEqual([id(101), id(103)]);
    const none = view([card(1, { status: 'removed', title: 'Secret premise' }), card(2)], [], { query: 'secret' });
    expect(none.rows.filter((row) => row.kind === 'branch')).toEqual([]);
    expect(none.empty).toBe('search');
    expect(view([card(1)], [], withPreferences({ filter: 'suggestions' })).empty).toBe('filter');
    expect(view([]).empty).toBe('none');
  });
});

describe('a long group', () => {
  const many = Array.from({ length: GROUP_LIMIT + 2 }, (_, n) => card(n + 1));

  it('folds past the limit into "More from … Show", and shows it all once the member opens it', () => {
    const folded = view(many).rows;
    expect(folded.filter((row) => row.kind === 'branch')).toHaveLength(GROUP_LIMIT);
    expect(folded.find((row) => row.kind === 'more')).toMatchObject({ hidden: 2, parentTitle: 'Part 2 title' });
    const opened = view(many, [], { preferences: { filter: 'everyone', expanded: ['root'] } }).rows;
    expect(opened.filter((row) => row.kind === 'branch')).toHaveLength(GROUP_LIMIT + 2);
    expect(opened.some((row) => row.kind === 'more')).toBe(false);
  });

  it('does not hide a match behind a fold while the member searches', () => {
    const rows = view(many, [], { query: `branch ${String(GROUP_LIMIT + 2)}` }).rows;
    expect(rows.filter((row) => row.kind === 'branch').map((row) => row.kind === 'branch' && row.title)).toEqual([
      `Branch ${String(GROUP_LIMIT + 2)}`,
    ]);
  });
});

describe('what the map keeps on this device', () => {
  const store = () => {
    const values = new Map<string, string>();
    const storage: ScopedStorage = {
      get: (key) => values.get(key),
      set: (key, value) => void values.set(key, value),
      remove: (key) => void values.delete(key),
    };
    return { storage, values };
  };

  it('remembers the filter and the groups opened, per thread', () => {
    const { storage } = store();
    saveMapPreferences(storage, 'thread-a', { filter: 'mine', expanded: ['root', id(101)] });
    expect(loadMapPreferences(storage, 'thread-a')).toEqual({ filter: 'mine', expanded: ['root', id(101)] });
    expect(loadMapPreferences(storage, 'thread-b')).toEqual(DEFAULT_MAP_PREFERENCES);
  });

  it('remembers which branch the member is in until they come back, and says original otherwise', () => {
    const { storage } = store();
    expect(loadHere(storage, 't')).toEqual({ kind: 'original' });
    saveHere(storage, 't', { kind: 'branch', nodeId: id(101) });
    expect(loadHere(storage, 't')).toEqual({ kind: 'branch', nodeId: id(101) });
    expect(loadHere(storage, 'other')).toEqual({ kind: 'original' });
    saveHere(storage, 't', { kind: 'original' });
    expect(loadHere(storage, 't')).toEqual({ kind: 'original' });
  });

  it('starts over from anything it cannot read', () => {
    const { storage, values } = store();
    values.set('thread.map.t', '{nope');
    expect(loadMapPreferences(storage, 't')).toEqual(DEFAULT_MAP_PREFERENCES);
    values.set('thread.map.t', JSON.stringify({ filter: 'weird', expanded: [1, 'ok', null] }));
    expect(loadMapPreferences(storage, 't')).toEqual({ filter: 'everyone', expanded: ['ok'] });
  });
});

describe('the way back from a branch', () => {
  it('names the part the member had selected, and says where it goes', () => {
    expect(returnTarget('Black holes', episodes, id(3))).toEqual({
      label: 'Part 3',
      spoken: 'Back to Black holes, Part 3',
    });
  });

  it('falls back to the first part when the selection is gone, and to the thread when it has no parts', () => {
    expect(returnTarget('Black holes', episodes, 'gone')).toMatchObject({ label: 'Part 1' });
    expect(returnTarget('Black holes', episodes.slice(0, 1), undefined)).toEqual({
      label: 'Black holes',
      spoken: 'Back to Black holes',
    });
  });
});
