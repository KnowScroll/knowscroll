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
    expect(readerKeyOf('3')).toEqual({ action: 'pick', option: 3 });
    expect(readerKeyOf('Enter')).toEqual({ action: 'lock-in' });
  });

  it('ignore every other key', () => {
    for (const key of ['x', 'Tab', 'Escape', '5', '0', 'Shift']) expect(readerKeyOf(key)).toBeUndefined();
  });
});
