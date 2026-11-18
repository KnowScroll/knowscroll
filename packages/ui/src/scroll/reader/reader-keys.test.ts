import { readerKeyOf } from './reader-keys';

describe('the reader keys', () => {
  it('map the keys of the design: arrows and Space read, right continues, N U A T F act, 1 to 4 pick, Enter locks in', () => {
    expect(readerKeyOf('ArrowDown')).toEqual({ action: 'next-stop' });
    expect(readerKeyOf(' ')).toEqual({ action: 'next-stop' });
    expect(readerKeyOf('ArrowUp')).toEqual({ action: 'previous-stop' });
    expect(readerKeyOf('ArrowRight')).toEqual({ action: 'next-part' });
    expect(readerKeyOf('ArrowLeft')).toEqual({ action: 'previous-part' });
    expect(readerKeyOf('N')).toEqual({ action: 'next-topic' });
    expect(readerKeyOf('u')).toEqual({ action: 'universe' });
    expect(readerKeyOf('?')).toEqual({ action: 'ask' });
    expect(readerKeyOf('3')).toEqual({ action: 'pick', option: 3 });
    expect(readerKeyOf('Enter')).toEqual({ action: 'lock-in' });
  });

  it('give each row of the ••• sheet its key, and Shift + S is Simpler where S alone is Save', () => {
    expect(readerKeyOf('s')).toEqual({ action: 'save' });
    expect(readerKeyOf('S')).toEqual({ action: 'save' });
    expect(readerKeyOf('S', true)).toEqual({ action: 'simpler' });
    expect(readerKeyOf('h')).toEqual({ action: 'share-moment' });
    expect(readerKeyOf('c')).toEqual({ action: 'challenge' });
    expect(readerKeyOf('p')).toEqual({ action: 'small-print' });
    expect(readerKeyOf('R')).toEqual({ action: 'report' });
  });

  it('ignore every other key', () => {
    for (const key of ['x', 'Tab', '5', '0', 'Shift']) expect(readerKeyOf(key)).toBeUndefined();
  });
});
