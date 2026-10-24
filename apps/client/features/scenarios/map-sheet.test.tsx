import { fireEvent, render, screen } from '@testing-library/react-native';
import type { MapRow, MapView } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { MapSheet } from './map-sheet';

const episode = (part: number, title: string, here = false): MapRow => ({
  kind: 'episode',
  key: `e${String(part)}`,
  depth: 0,
  assetId: `asset-${String(part)}`,
  part,
  title,
  here,
  unavailable: false,
});
const branch = (patch: Partial<Extract<MapRow, { kind: 'branch' }>>): MapRow => ({
  kind: 'branch',
  key: patch.nodeId ?? 'n1',
  depth: 1,
  nodeId: 'n1',
  branchKind: 'what_if',
  title: 'a black hole were a portal',
  status: 'ready',
  hypothetical: true,
  speculative: false,
  openable: true,
  mine: true,
  here: false,
  ...patch,
});

const view = (rows: MapRow[], patch: Partial<MapView> = {}): MapView => ({
  title: 'Black holes',
  rows,
  empty: undefined,
  ...patch,
});

async function show(
  mapView: MapView,
  options: { large?: boolean; filter?: 'mine' | 'everyone' | 'suggestions'; query?: string } = {},
) {
  const handlers = {
    onFilter: jest.fn(),
    onQuery: jest.fn(),
    onClose: jest.fn(),
    onOpenEpisode: jest.fn(),
    onOpenBranch: jest.fn(),
    onOpenOffer: jest.fn(),
    onShowMore: jest.fn(),
  };
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <MapSheet
        visible
        view={mapView}
        large={options.large ?? false}
        filter={options.filter ?? 'everyone'}
        query={options.query ?? ''}
        {...handlers}
      />
    </DisplayProvider>,
  );
  return handlers;
}

describe('the map of a thread', () => {
  it('shows the original sequence with its branches nested, and opens what is pressed', async () => {
    const handlers = await show(view([episode(1, 'The edge'), episode(2, 'Falling in'), branch({})]));
    expect(screen.getByText('ORIGINAL · BLACK HOLES')).toBeOnTheScreen();
    expect(screen.getByLabelText('Map of Black holes')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Part 2: Falling in'));
    expect(handlers.onOpenEpisode).toHaveBeenCalledWith('asset-2');
    await fireEvent.press(screen.getByLabelText('What if: a black hole were a portal'));
    expect(handlers.onOpenBranch).toHaveBeenCalledWith('n1');
  });

  it('keeps search and the filter for a large map, and leaves a small one as just its outline', async () => {
    const small = await show(view([episode(1, 'The edge')]), { large: false });
    expect(screen.queryByLabelText('Search branches')).toBeNull();
    expect(screen.queryByRole('togglebutton', { name: 'Mine' })).toBeNull();
    expect(small.onFilter).not.toHaveBeenCalled();
  });

  it('searches and filters when it is large', async () => {
    const handlers = await show(view([episode(1, 'The edge'), branch({})]), { large: true, filter: 'mine' });
    await fireEvent.changeText(screen.getByLabelText('Search branches'), 'portal');
    expect(handlers.onQuery).toHaveBeenCalledWith('portal');
    expect(screen.getByRole('togglebutton', { name: 'Mine' }).props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByRole('togglebutton', { name: 'Everyone' }).props.accessibilityState).toMatchObject({
      checked: false,
    });
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Suggestions' }));
    expect(handlers.onFilter).toHaveBeenCalledWith('suggestions');
  });

  it('marks only the member’s own position with "You"', async () => {
    await show(view([episode(1, 'The edge', true), branch({ nodeId: 'n1' }), branch({ nodeId: 'n2', here: false })]));
    expect(screen.getAllByLabelText('You are here')).toHaveLength(1);
  });

  it('shows a suggestion dashed, not made and without a number, and offers it to the member', async () => {
    const handlers = await show(
      view([
        episode(1, 'The edge'),
        {
          kind: 'suggestion',
          key: 's1',
          depth: 1,
          draftId: 'd1',
          optionId: 'o1',
          title: 'What if it were smaller?',
          speculative: false,
        },
      ]),
    );
    expect(screen.getByText('SUGGESTION · NOT MADE')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Suggestion, not made: What if it were smaller?'));
    expect(handlers.onOpenOffer).toHaveBeenCalledWith('d1', 'o1');
  });

  it('says a removed, preparing or failed branch is so, and does not let it open', async () => {
    await show(
      view([
        branch({ nodeId: 'a', status: 'removed', title: 'Removed', openable: false, hypothetical: false }),
        branch({ nodeId: 'b', status: 'preparing', title: 'it spun faster', openable: false }),
        branch({ nodeId: 'c', status: 'failed', title: 'it was cold', openable: false }),
      ]),
    );
    expect(screen.getByLabelText(/What if: Removed/)).toBeDisabled();
    expect(screen.getByText('Preparing')).toBeOnTheScreen();
    expect(screen.getByText('Couldn’t prepare this branch')).toBeOnTheScreen();
    expect(screen.getByLabelText(/it spun faster, Preparing/)).toBeDisabled();
  });

  it('says a speculative branch’s premise in words, not as a tag', async () => {
    await show(view([branch({ speculative: true })]));
    expect(screen.getByText('Speculative scenario · not established science')).toBeOnTheScreen();
    expect(screen.queryByText('Speculative')).toBeNull();
  });

  it('folds long groups and opens one when asked', async () => {
    const handlers = await show(
      view([
        episode(1, 'The edge'),
        { kind: 'more', key: 'm1', depth: 1, groupKey: 'root', hidden: 4, parentTitle: 'Part 1' },
      ]),
    );
    await fireEvent.press(screen.getByRole('button', { name: '4 more from Part 1. Show' }));
    expect(handlers.onShowMore).toHaveBeenCalledWith('root');
  });

  it('says an episode that is no longer available is so', async () => {
    await show(view([{ ...episode(3, 'Gone'), unavailable: true } as MapRow]));
    expect(screen.getByLabelText('Part 3: Gone, no longer available')).toBeOnTheScreen();
  });

  it('says why it is empty', async () => {
    await show(view([], { empty: 'search' }), { large: true });
    expect(screen.getByText('No branch matches that.')).toBeOnTheScreen();
  });
});
