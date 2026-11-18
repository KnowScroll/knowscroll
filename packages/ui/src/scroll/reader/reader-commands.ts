/**
 * What a Scroll reader is handed by the screen it is on: the moves beyond reading, and the words for the
 * ways on. The same for every reader, so a screen wires its moves once whichever reader draws the Scroll.
 */

/** What the app can do for the reader beyond reading: each is also a button, so no key or gesture stands alone. */
export interface ReaderCommands {
  readonly universe?: () => void;
  readonly ask?: () => void;
  readonly format?: () => void;
  /** Continue: the next Part, or another angle when there is no next Part (D-184). */
  readonly wayOn?: () => void;
  readonly previousPart?: () => void;
  readonly nextTopic?: () => void;
  /** Challenge a friend with one of this Scroll's calls (D-245); absent where it cannot be sent. */
  readonly challenge?: (() => void) | undefined;
  /** The ••• sheet's other rows (V3 G5), each also a key; absent where the screen cannot do it (a thread's reader has no Save). */
  readonly save?: (() => void) | undefined;
  readonly shareMoment?: (() => void) | undefined;
  readonly smallPrint?: (() => void) | undefined;
  readonly report?: (() => void) | undefined;
  /** Goes back to the Scroll a new topic left (V3 G4), while the note that offers it is showing. */
  readonly undo?: (() => void) | undefined;
  /** Opens Ask from here anchored to a stop, with the passage the reader selected as the draft question (D-244). */
  readonly askAbout?: ((stopId: string, passage: string) => void) | undefined;
}

/** Runs a command the app may not provide; whether it ran is whether the key or swipe was used. */
export function run(command: (() => void) | undefined): boolean {
  if (command === undefined) return false;
  command();
  return true;
}

/** A Part as the end plate and the dock offer it: only an admitted continuation is ever shown. */
export interface NextPartPeek {
  /** "Part 2". */
  readonly label: string;
  readonly title: string;
  readonly onPress: () => void;
}

/** What the reader says when it was opened by a move to the next Part. */
export interface PartArrival {
  /** The Part now on screen: "Part 2". */
  readonly part: string;
  /** The Part left behind, whose place is kept: "Part 1". */
  readonly from: string;
}

/** What a screen can ask of the reader drawing its Scroll, whichever reader that is. */
export interface ReaderHandle {
  /** The stop being read (the beat at the reading line, or the stop on screen), or `undefined` at the end. */
  readonly capture: () => { readonly stopId: string } | undefined;
  readonly jumpToStop: (stopId: string) => void;
  /** Switches the stop being read between its words and its plainer ones; false when it has none (a call, the end). */
  readonly toggleSimpler: () => boolean;
  /** Shows or hides every picture's text version; false when the Scroll has nothing to show as words. */
  readonly toggleTextVersion: () => boolean;
  /** What the ••• sheet needs to draw its rows for the stop being read now. */
  readonly view: () => ReaderView;
}

/** The reader's state as the ••• sheet draws it. */
export interface ReaderView {
  /** The stop being read when it has plainer words, otherwise `undefined`. */
  readonly simplerStopId: string | undefined;
  readonly simplerOn: boolean;
  readonly hasTextVersion: boolean;
  readonly textVersionOn: boolean;
}
