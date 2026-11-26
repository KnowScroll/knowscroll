import { readCrossingParams } from './crossing-gallery-params';

describe('the crossing gallery address', () => {
  it('has the prototype as its defaults', () => {
    expect(readCrossingParams({})).toEqual({
      q: 0.3,
      direction: 'out',
      name: 'Ravi',
      shared: ['Attention', 'Stars'],
      play: false,
      seen: false,
    });
  });

  it('reads q, dir, name, shared, play and seen', () => {
    expect(
      readCrossingParams({ q: '0.64', dir: 'home', name: ' Mei ', shared: 'Maps, Tides', play: '1', seen: '1' }),
    ).toEqual({
      q: 0.64,
      direction: 'home',
      name: 'Mei',
      shared: ['Maps', 'Tides'],
      play: true,
      seen: true,
    });
  });

  it('keeps q in 0 to 1, falls back when it is not a number, and allows nothing shared', () => {
    expect(readCrossingParams({ q: '3' }).q).toBe(1);
    expect(readCrossingParams({ q: '-3' }).q).toBe(0);
    expect(readCrossingParams({ q: 'soon' }).q).toBe(0.3);
    expect(readCrossingParams({ q: '' }).q).toBe(0.3);
    expect(readCrossingParams({ shared: '' }).shared).toEqual([]);
  });
});
