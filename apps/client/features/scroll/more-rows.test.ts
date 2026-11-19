import type { ReaderView } from '@knowscroll/ui';
import { moreRowsOf, type MoreRowInput } from './more-rows';

const view: ReaderView = {
  simplerStopId: 'stop-1',
  simplerOn: false,
  hasTextVersion: true,
  textVersionOn: false,
};
const act = {
  challenge: jest.fn(),
  toggleTextVersion: jest.fn(),
  toggleSimpler: jest.fn(),
  smallPrint: jest.fn(),
  report: jest.fn(),
};
const everything: MoreRowInput = {
  ask: jest.fn(),
  canChallenge: true,
  hasSmallPrint: true,
  view,
  act,
};
const idsOf = (input: MoreRowInput) => moreRowsOf(input).map((row) => row.id);

describe('the rows of the ••• sheet (D-429)', () => {
  it('are six, Ask about this first, each with a sub-line and a key', () => {
    const rows = moreRowsOf(everything);
    expect(rows.map((row) => [row.title, row.keyName])).toEqual([
      ['Ask about this', 'A'],
      ['Challenge a friend', 'C'],
      ['Text version', 'T'],
      ['Simpler (this screen)', '⇧S'],
      ['Small print', 'P'],
      ['Report', 'R'],
    ]);
    for (const row of rows) expect(row.detail).not.toBe('');
  });

  it("have no Save and no Share a moment: Like, Share and Save are the dock's", () => {
    const ids = idsOf(everything);
    expect(ids).not.toContain('save');
    expect(ids).not.toContain('share-moment');
    expect(ids).not.toContain('like');
  });

  it('open Ask directly', () => {
    const ask = jest.fn();
    moreRowsOf({ ...everything, ask })
      .find((row) => row.id === 'ask')
      ?.onPress();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('leave out what cannot work on this Scroll or screen, and keep the rest in order', () => {
    expect(idsOf({ ...everything, ask: undefined })).not.toContain('ask');
    expect(idsOf({ ...everything, canChallenge: false })).not.toContain('challenge');
    expect(idsOf({ ...everything, hasSmallPrint: false })).not.toContain('small-print');
    expect(idsOf({ ...everything, view: { ...view, hasTextVersion: false } })).not.toContain('text-version');
    expect(idsOf({ ...everything, ask: undefined, canChallenge: false, hasSmallPrint: false })).toEqual([
      'text-version',
      'simpler',
      'report',
    ]);
  });

  it('dim Simpler where the stop has no plainer words, and say why', () => {
    const rows = moreRowsOf({ ...everything, view: { ...view, simplerStopId: undefined } });
    const simpler = rows.find((row) => row.id === 'simpler');
    expect(simpler?.disabled).toBe(true);
    expect(simpler?.detail).toBe('Only a stop of reading has plainer words');
  });

  it('say what is switched on for the text version and Simpler, so the plainer words can be undone from here', () => {
    const rows = moreRowsOf({ ...everything, view: { ...view, simplerOn: true, textVersionOn: true } });
    expect(rows.find((row) => row.id === 'text-version')).toMatchObject({ toggled: true });
    expect(rows.find((row) => row.id === 'simpler')).toMatchObject({
      toggled: true,
      detail: 'Showing this stop in plainer words',
      onPress: act.toggleSimpler,
    });
  });
});
