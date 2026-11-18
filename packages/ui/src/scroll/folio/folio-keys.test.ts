import { folioKeyOf } from './folio-keys';

describe('the keys of the essay (folio README 5.4)', () => {
  it('scrolls a step with the arrows, a screen with Space and Page keys, and to either end with Home and End', () => {
    expect(folioKeyOf('ArrowDown')).toEqual({ action: 'next-stop' });
    expect(folioKeyOf('ArrowUp')).toEqual({ action: 'previous-stop' });
    expect(folioKeyOf(' ')).toEqual({ action: 'page-down' });
    expect(folioKeyOf(' ', true)).toEqual({ action: 'page-up' });
    expect(folioKeyOf('PageDown')).toEqual({ action: 'page-down' });
    expect(folioKeyOf('Home')).toEqual({ action: 'to-start' });
    expect(folioKeyOf('End')).toEqual({ action: 'to-end' });
  });

  it("keeps every reader's keys for the ••• rows, Ask and the moves", () => {
    expect(folioKeyOf('n')).toEqual({ action: 'next-topic' });
    expect(folioKeyOf('ArrowRight')).toEqual({ action: 'next-part' });
    expect(folioKeyOf('S', true)).toEqual({ action: 'simpler' });
    expect(folioKeyOf('t')).toEqual({ action: 'text-version' });
  });

  it('leaves the option keys and Enter to the browser: a call is text here', () => {
    expect(folioKeyOf('1')).toBeUndefined();
    expect(folioKeyOf('Enter')).toBeUndefined();
  });
});
