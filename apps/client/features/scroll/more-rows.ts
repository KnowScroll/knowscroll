import type { MoreRow, StageReaderView } from '@knowscroll/ui';
import type { NoMoment } from '@knowscroll/scroll-model';
import { noMomentWords } from '../threads/share-stop-sheet';

/** Save as a screen offers it: whether this Scroll is kept, whether a save is in flight, and what pressing does. */
export interface SaveMove {
  readonly saved: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
}

/** What the ••• sheet needs to know to say which rows can work here. */
export interface MoreRowInput {
  readonly save: SaveMove | undefined;
  /** Why the stop on screen cannot be shared as a moment; `undefined` when it can. */
  readonly noMoment: NoMoment | undefined;
  /** Whether the Scroll has a call to challenge a friend with. */
  readonly canChallenge: boolean;
  /** Whether the document names a limits aside. */
  readonly hasSmallPrint: boolean;
  readonly view: StageReaderView | undefined;
  readonly act: {
    readonly shareMoment: () => void;
    readonly challenge: () => void;
    readonly toggleTextVersion: () => void;
    readonly toggleSimpler: () => void;
    readonly smallPrint: () => void;
    readonly report: () => void;
  };
}

/**
 * The seven rows of a Scroll's ••• sheet, in the order of the design (V3 G5): Save, Share a moment, Challenge a friend,
 * Text version, Simpler, Small print, Report. A row that cannot work on this Scroll is left out (no Save on a screen that
 * keeps nothing, no Challenge on a Scroll with no call, no Text version on a Scroll with no picture, no Small print
 * without a limits aside); a row that cannot work on this stop is dimmed and says why (a call is not a moment, a
 * call and the end have no plainer words). Each row's key is the same key the reader answers to.
 */
export function moreRowsOf(input: MoreRowInput): readonly MoreRow[] {
  const { save, noMoment, view, act } = input;
  const rows: MoreRow[] = [];
  if (save !== undefined)
    rows.push({
      id: 'save',
      title: save.saved ? 'Saved' : 'Save',
      detail: save.saved ? 'This Scroll is in Saved' : 'Keep this Scroll in Saved',
      keyName: 'S',
      onPress: save.onPress,
      disabled: save.busy,
      toggled: save.saved,
    });
  rows.push({
    id: 'share-moment',
    title: 'Share a moment',
    detail: noMoment === undefined ? 'This stop, with its picture' : noMomentWords(noMoment),
    keyName: 'H',
    onPress: act.shareMoment,
    disabled: noMoment !== undefined,
  });
  if (input.canChallenge)
    rows.push({
      id: 'challenge',
      title: 'Challenge a friend',
      detail: 'Send one of its calls to a friend',
      keyName: 'C',
      onPress: act.challenge,
    });
  if (view?.hasTextVersion === true)
    rows.push({
      id: 'text-version',
      title: 'Text version',
      detail: view.textVersionOn ? 'Showing the picture as words' : 'The picture as words',
      keyName: 'T',
      onPress: act.toggleTextVersion,
      toggled: view.textVersionOn,
    });
  rows.push({
    id: 'simpler',
    title: 'Simpler (this screen)',
    detail:
      view?.simplerStopId === undefined
        ? 'Only a stop of reading has plainer words'
        : view.simplerOn
          ? 'Showing this stop in plainer words'
          : 'This stop in plainer words',
    keyName: '⇧S',
    onPress: act.toggleSimpler,
    disabled: view?.simplerStopId === undefined,
    toggled: view?.simplerStopId === undefined ? undefined : view.simplerOn,
  });
  if (input.hasSmallPrint)
    rows.push({
      id: 'small-print',
      title: 'Small print',
      detail: 'Where this stops working',
      keyName: 'P',
      onPress: act.smallPrint,
    });
  rows.push({
    id: 'report',
    title: 'Report',
    detail: 'Something wrong here',
    keyName: 'R',
    onPress: act.report,
  });
  return rows;
}
