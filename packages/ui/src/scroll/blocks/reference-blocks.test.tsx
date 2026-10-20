import { Text } from 'react-native';
import { configure, screen } from '@testing-library/react-native';
import { ScrollArticle } from '../article';
import { audioBlock, comparisonBlock, figureBlock, tableBlock, timelineBlock } from '../fixtures/blocks';
import type { ScrollMediaRequest } from '../media';
import { anyNumber, articleOf, show } from '../../test-support/scroll';
import { observerDouble } from '../../test-support/scroll';

/** The reference blocks: table, figure, clip, comparison, timeline. */

beforeAll(() => {
  configure({ defaultIncludeHiddenElements: true });
});

afterAll(() => {
  configure({ defaultIncludeHiddenElements: false });
});

const ALT = 'A side view of a stone arch bridge, its stones leaning together under the road.';

describe('a table', () => {
  it('is a table: its caption, a header row with units, cells aligned as declared, numbers grouped', async () => {
    await show(<ScrollArticle document={articleOf([tableBlock('t-loads')])} />);

    expect(screen.getByLabelText('Deck weight by span, as an illustration')).toHaveProp('role', 'table');
    expect(screen.getByText('Deck weight by span, as an illustration')).toBeOnTheScreen();
    expect(screen.getByText('Span (m)')).toBeOnTheScreen();
    expect(screen.getByText('Deck weight (kN)')).toBeOnTheScreen();
    expect(screen.getByText('2,220')).toHaveStyle({ textAlign: 'right' });
    expect(screen.getByText('Concrete')).not.toHaveStyle({ textAlign: 'right' });
    expect(screen.getAllByText('Steel')).toHaveLength(3);
  });

  it('declares no gesture and is its own text version', () => {
    expect(tableBlock('tbl-gesture').gesture).toBe('none');
  });
});

describe('a figure', () => {
  it('is a placeholder until the media pipeline exists: an image with its alt text in plain sight and its caption', async () => {
    await show(<ScrollArticle document={articleOf([figureBlock('fig-arch')])} />);

    expect(screen.getByLabelText(ALT)).toHaveProp('accessibilityRole', 'image');
    expect(screen.getByText('Image · not loaded')).toBeOnTheScreen();
    expect(screen.getByText(ALT)).toBeOnTheScreen();
    expect(screen.getByText('In an arch every stone is pressed by its neighbours.')).toBeOnTheScreen();
  });

  it('draws what the app draws for the admitted asset, and the placeholder when it draws nothing', async () => {
    const requests: ScrollMediaRequest[] = [];
    const first = await show(
      <ScrollArticle
        document={articleOf([figureBlock('fig-arch')])}
        renderMedia={(request) => {
          requests.push(request);
          return <Text>{`drawn ${request.media.mediaId}`}</Text>;
        }}
      />,
    );
    expect(screen.getByText('drawn fixture-arch')).toBeOnTheScreen();
    expect(screen.queryByText('Image · not loaded')).toBeNull();
    expect(requests[0]).toMatchObject({ kind: 'still', alt: ALT, reducedMotion: true });
    await first.unmount();

    await show(<ScrollArticle document={articleOf([figureBlock('fig-arch')])} renderMedia={() => null} />);
    expect(screen.getByText('Image · not loaded')).toBeOnTheScreen();
  });

  it('asks for the poster of a loop under reduced motion, and says so only then', async () => {
    const loop = figureBlock('fig-loop');
    const looping = { ...loop, data: { ...loop.data, motion: 'loop' as const } };
    const requests: ScrollMediaRequest[] = [];
    const draw = (request: ScrollMediaRequest) => {
      requests.push(request);
      return null;
    };

    const reduced = await show(<ScrollArticle document={articleOf([looping])} renderMedia={draw} />, {
      reducedMotion: true,
    });
    await reduced.unmount();
    await show(<ScrollArticle document={articleOf([looping])} renderMedia={draw} />, { reducedMotion: false });

    expect(requests.every((request) => request.kind === 'loop')).toBe(true);
    expect(requests.some((request) => request.reducedMotion)).toBe(true);
    expect(requests[requests.length - 1]?.reducedMotion).toBe(false);
  });
});

describe('a clip', () => {
  it('is its placeholder and its transcript, which is also its text version and is always shown; nothing plays', async () => {
    await show(<ScrollArticle document={articleOf([audioBlock('audio-1')])} />);

    expect(screen.getByText('Audio · 0:42 · not loaded')).toBeOnTheScreen();
    expect(screen.getByText('Transcript')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'A deck grows a little in the heat and shrinks in the cold. One end is fixed and the other rests on a bearing, so it can slide and the bridge does not push itself apart.',
      ),
    ).toBeOnTheScreen();
    // A control whose backend does not exist is not rendered.
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('a comparison', () => {
  it('sets two columns side by side, each a labelled group with its points and the marks on them', async () => {
    await show(<ScrollArticle document={articleOf([comparisonBlock('cmp-two')])} />);

    expect(screen.getByLabelText('Arch')).not.toHaveStyle({ alignSelf: 'stretch' });
    expect(screen.getByLabelText('Suspension')).toBeOnTheScreen();
    expect(screen.getByText('Pushes inward on its ends.')).toBeOnTheScreen();
    expect(screen.getByText('tension')).toHaveStyle({ fontStyle: 'italic' });
    expect(screen.getByText('Each design puts the same load somewhere different.')).toBeOnTheScreen();
  });

  it('stacks three columns on a phone, where a third would be too narrow, and sets them side by side on a tablet', async () => {
    const phone = await show(<ScrollArticle document={articleOf([comparisonBlock('cmp-three', 3)])} />);
    expect(screen.getByLabelText('Beam')).toHaveStyle({ alignSelf: 'stretch' });
    await phone.unmount();

    await show(<ScrollArticle document={articleOf([comparisonBlock('cmp-three', 3)])} />, { width: 834 });
    expect(screen.getByLabelText('Beam')).not.toHaveStyle({ alignSelf: 'stretch' });
  });
});

describe('a timeline', () => {
  it('lists its events in the order of the document, when first, with their detail', async () => {
    await show(<ScrollArticle document={articleOf([timelineBlock('tl-century')])} />);

    expect(screen.getAllByText(/^Year \d+$/).map((entry) => entry.props.children as string)).toEqual([
      'Year 0',
      'Year 3',
      'Year 40',
      'Year 100',
    ]);
    expect(screen.getByText('First big repair')).toBeOnTheScreen();
    expect(screen.getByText('Joints and bearings are replaced; the structure stays.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Timeline: a bridge’s first century')).toBeOnTheScreen();
  });
});

describe('every reference block', () => {
  it('reports nothing to the observer by itself: only deliberate interactions are events', async () => {
    const watcher = observerDouble();
    await show(
      <ScrollArticle
        document={articleOf([
          tableBlock('tbl-one'),
          figureBlock('fig-one'),
          audioBlock('aud-one'),
          comparisonBlock('cmp-one'),
          timelineBlock('tml-one'),
        ])}
        observer={watcher}
      />,
    );
    expect(watcher.onBlockInteraction).not.toHaveBeenCalled();
    expect(watcher.onBlockVisibility).toHaveBeenCalledWith({ blockId: 'tbl-one', visibleFraction: 0, at: anyNumber });
  });
});
