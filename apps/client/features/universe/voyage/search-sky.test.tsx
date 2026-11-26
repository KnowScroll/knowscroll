import { render, screen } from '@testing-library/react-native';
import type { SpaceAnchor } from '../space/space-surface';
import { litAnchors, ringOf, SearchSky } from './search-sky';

const anchor = (id: string, over: Partial<SpaceAnchor> = {}): SpaceAnchor => ({
  id,
  kind: 'system',
  name: id,
  systemId: id,
  x: 100,
  y: 200,
  radiusPx: 6,
  visible: true,
  ...over,
});
/** The sky is hidden from assistive technology, so a query must say it may look at hidden things too. */
const find = (testID: string) => screen.queryByTestId(testID, { includeHiddenElements: true });
const SIZE = { width: 390, height: 844 };

describe('which stars wear a ring', () => {
  it('is the systems on screen that hold a match, and nothing else', () => {
    const anchors = [
      anchor('a'),
      anchor('b'),
      anchor('c', { visible: false }),
      anchor('planet-of-a', { kind: 'planet', systemId: 'a' }),
    ];
    expect(litAnchors(anchors, ['a', 'c', 'planet-of-a']).map((lit) => lit.id)).toEqual(['a']);
    expect(litAnchors(anchors, [])).toEqual([]);
  });
});

describe('the ring round a lit star', () => {
  it('is the prototype’s 72 points for a small star', () => {
    expect(ringOf(6)).toEqual({ ring: 18, glow: 72 });
  });

  it('clears the edge of a large star, the glow growing with it', () => {
    const { ring, glow } = ringOf(36);
    expect(ring).toBe(42);
    expect(glow).toBe(168);
  });
});

describe('the sky’s answer to a search', () => {
  it('lays a flat dim while nothing is typed, and no rings', async () => {
    await render(<SearchSky answer={{ lit: null }} anchors={[anchor('a')]} size={SIZE} />);
    expect(find('universe-search-dim')).not.toBeNull();
    expect(find('voyage-search-lit-a')).toBeNull();
  });

  it('rings each lit star once and no other, with no flat dim over them', async () => {
    await render(
      <SearchSky
        answer={{ lit: ['a', 'c'] }}
        anchors={[anchor('a'), anchor('b', { x: 50 }), anchor('c', { x: 300 })]}
        size={SIZE}
      />,
    );
    expect(find('voyage-search-lit-a')).not.toBeNull();
    expect(find('voyage-search-lit-c')).not.toBeNull();
    expect(find('voyage-search-lit-b')).toBeNull();
    expect(find('universe-search-dim')).toBeNull();
  });

  it('dims the whole sky and rings nothing when a query matches no system', async () => {
    await render(<SearchSky answer={{ lit: [] }} anchors={[anchor('a')]} size={SIZE} />);
    expect(find('voyage-search-sky')).not.toBeNull();
    expect(find('voyage-search-lit-a')).toBeNull();
  });

  it('takes no touch and says nothing to assistive technology', async () => {
    await render(<SearchSky answer={{ lit: ['a'] }} anchors={[anchor('a')]} size={SIZE} />);
    expect(find('voyage-search-sky')).toHaveProp('pointerEvents', 'none');
    expect(find('voyage-search-sky')).toHaveProp('aria-hidden', true);
  });
});
