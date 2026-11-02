import type { StageReaderView } from '@knowscroll/ui';
import { moreRowsOf, type MoreRowInput } from './more-rows';

const view: StageReaderView = {
  simplerStopId: 'stop-1',
  simplerOn: false,
  hasTextVersion: true,
  textVersionOn: false,
};
const act = {
  shareMoment: jest.fn(),
  challenge: jest.fn(),
  toggleTextVersion: jest.fn(),
  toggleSimpler: jest.fn(),
  smallPrint: jest.fn(),
  report: jest.fn(),
};
const everything: MoreRowInput = {
  save: { saved: false, busy: false, onPress: jest.fn() },
  noMoment: undefined,
  canChallenge: true,
  hasSmallPrint: true,
  view,
  act,
};
const idsOf = (input: MoreRowInput) => moreRowsOf(input).map((row) => row.id);

describe('the rows of the ••• sheet (V3 G5)', () => {
  it('are the seven of the design, in its order, each with a sub-line and a key', () => {
    const rows = moreRowsOf(everything);
    expect(rows.map((row) => [row.title, row.keyName])).toEqual([
      ['Save', 'S'],
      ['Share a moment', 'H'],
      ['Challenge a friend', 'C'],
      ['Text version', 'T'],
      ['Simpler (this screen)', '⇧S'],
      ['Small print', 'P'],
      ['Report', 'R'],
    ]);
    for (const row of rows) expect(row.detail).not.toBe('');
  });

  it('leave out what cannot work on this Scroll or screen, and keep the rest in order', () => {
    expect(idsOf({ ...everything, save: undefined })).not.toContain('save');
    expect(idsOf({ ...everything, canChallenge: false })).not.toContain('challenge');
    expect(idsOf({ ...everything, hasSmallPrint: false })).not.toContain('small-print');
    expect(idsOf({ ...everything, view: { ...view, hasTextVersion: false } })).not.toContain('text-version');
    expect(idsOf({ ...everything, save: undefined, canChallenge: false, hasSmallPrint: false })).toEqual([
      'share-moment',
      'text-version',
      'simpler',
      'report',
    ]);
  });

  it('dim Share a moment on a call and say why, and Simpler where the stop has no plainer words', () => {
    const rows = moreRowsOf({ ...everything, noMoment: 'call', view: { ...view, simplerStopId: undefined } });
    const moment = rows.find((row) => row.id === 'share-moment');
    expect(moment?.disabled).toBe(true);
    expect(moment?.detail).toContain('would give its answer away');
    expect(rows.find((row) => row.id === 'simpler')?.disabled).toBe(true);
  });

  it('say Saved for a kept Scroll and what is switched on for the text version and Simpler', () => {
    const rows = moreRowsOf({
      ...everything,
      save: { saved: true, busy: false, onPress: jest.fn() },
      view: { ...view, simplerOn: true, textVersionOn: true },
    });
    expect(rows.find((row) => row.id === 'save')).toMatchObject({ title: 'Saved', toggled: true });
    expect(rows.find((row) => row.id === 'text-version')).toMatchObject({ toggled: true });
    expect(rows.find((row) => row.id === 'simpler')).toMatchObject({ toggled: true });
  });
});
