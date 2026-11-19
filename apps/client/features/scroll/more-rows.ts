import type { MoreRow, ReaderView } from '@knowscroll/ui';

/** What the ••• sheet needs to know to say which rows can work here. */
export interface MoreRowInput {
  /** Opens Ask anchored to the stop on screen; absent where the screen offers no Ask. */
  readonly ask: (() => void) | undefined;
  /** Whether the Scroll has a call to challenge a friend with. */
  readonly canChallenge: boolean;
  /** Whether the document names a limits aside. */
  readonly hasSmallPrint: boolean;
  readonly view: ReaderView | undefined;
  readonly act: {
    readonly challenge: () => void;
    readonly toggleTextVersion: () => void;
    readonly toggleSimpler: () => void;
    readonly smallPrint: () => void;
    readonly report: () => void;
  };
}

/**
 * The rows of a Scroll's ••• sheet, in order (D-429, after V3 G5): Ask about this, Challenge a friend, Text version,
 * Simpler, Small print, Report. Like, Share and Save are the dock's own controls, so they are not rows. A row that
 * cannot work on this Scroll is left out (no Ask on a screen that offers none, no Challenge on a Scroll with no call,
 * no Text version on a Scroll with no picture, no Small print without a limits aside); a row that cannot work on this
 * stop is dimmed and says why (a call and the end have no plainer words). Each row's key is the same key the reader
 * answers to; A and ? open Ask directly, Simpler is the only way to plainer words besides Shift + S and the selection
 * menu (there is no link under the paragraph).
 */
export function moreRowsOf(input: MoreRowInput): readonly MoreRow[] {
  const { ask, view, act } = input;
  const rows: MoreRow[] = [];
  if (ask !== undefined)
    rows.push({
      id: 'ask',
      title: 'Ask about this',
      detail: 'A question about the part you are reading',
      keyName: 'A',
      onPress: ask,
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
