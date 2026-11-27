import { readMapsParams } from './maps-gallery-params';

describe('what the maps gallery reads from its address', () => {
  it('shows map 1 of four regions, with nothing marked, by default', () => {
    expect(readMapsParams({})).toEqual({
      map: 1,
      regions: 4,
      seam: false,
      here: false,
      preview: 'scroll',
      hypothetical: false,
      type: 'lush',
    });
  });

  it('reads every choice', () => {
    expect(
      readMapsParams({
        map: '2',
        regions: '12',
        seam: '1',
        here: '1',
        preview: 'offline',
        hypothetical: '1',
        type: 'gas',
      }),
    ).toEqual({ map: 2, regions: 12, seam: true, here: true, preview: 'offline', hypothetical: true, type: 'gas' });
  });

  it('takes the first of a repeated value and falls back on what it does not know', () => {
    expect(readMapsParams({ map: ['2', '1'] }).map).toBe(2);
    expect(readMapsParams({ map: '3' }).map).toBe(1);
    for (const regions of ['0', '13', '2.5', 'many', '']) expect(readMapsParams({ regions }).regions).toBe(4);
    expect(readMapsParams({ regions: '1' }).regions).toBe(1);
    expect(readMapsParams({ preview: 'nonsense' }).preview).toBe('scroll');
    expect(readMapsParams({ type: 'volcanic' }).type).toBe('lush');
  });
});
