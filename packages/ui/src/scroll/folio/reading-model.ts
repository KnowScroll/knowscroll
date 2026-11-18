import type { Aside, Guide, Interactive } from '@knowscroll/scroll-model';
import type { FigureState } from '../stage/kit-figure';

/**
 * What the Folio reader draws: an essay as sections of beats and figures. The reader knows no document version;
 * an adapter per version builds this (`from-v2.ts`). Ids are the document's own unit ids, so reading evidence, a
 * kept place, Ask and Quick answer go on naming what they name today.
 */
export interface ReadingModel {
  readonly assetId: string;
  readonly revision: number;
  readonly kicker: string;
  readonly title: string;
  readonly dek: string;
  readonly sections: readonly ReadingSection[];
  readonly end: EndPlate;
}

/** A division inside one Scroll (not a Part, which is a Scroll of its own). Today's Scrolls have one, untitled. */
export interface ReadingSection {
  readonly id: string;
  readonly heading?: string | undefined;
  readonly blocks: readonly ReadingBlock[];
}

export type ReadingBlock = BeatBlock | FigureBlock | HoldBlock;

/** One unit of reading: what is read in one go, and what reading evidence names. */
export interface Beat {
  /** The document's unit id: a v2 stop id. */
  readonly id: string;
  /** A question is a call drawn as text: its prompt, then its explanation. */
  readonly kind: 'prose' | 'question';
  readonly heading?: string | undefined;
  readonly text: readonly BeatText[];
  /** The same idea in plainer words, shown on request. */
  readonly simple?: string | undefined;
  readonly guide?: Guide | undefined;
  readonly play?: Interactive | undefined;
  /** Side notes that open next to this beat. */
  readonly notes: readonly Aside[];
}

export interface BeatText {
  /** A line stands alone for rhythm; a paragraph is prose. */
  readonly kind: 'paragraph' | 'line';
  readonly text: string;
}

export interface BeatBlock {
  readonly kind: 'beat';
  readonly beat: Beat;
}

/** A control under a figure. Earth's tilt is the only one today (D-187). */
export interface FigureControl {
  readonly kind: 'tilt';
}

export interface FigureBlock {
  readonly kind: 'figure';
  readonly id: string;
  readonly figure: FigureState;
  readonly control?: FigureControl | undefined;
}

/** A figure that holds while two or three beats pass, taking each beat's state as that beat reaches the reading line. */
export interface HoldBlock {
  readonly kind: 'hold';
  readonly id: string;
  readonly beats: readonly HeldBeat[];
}

export interface HeldBeat {
  readonly beat: Beat;
  readonly figure: FigureState;
}

/** The end of the essay: the takeaway and the picture of the whole journey. The ways on are the screen's. */
export interface EndPlate {
  readonly takeaway: readonly string[];
  readonly figure?: FigureState | undefined;
  readonly smallPrint?: { readonly title: string; readonly text: string } | undefined;
}

/** Every beat of the essay in reading order, those in holds included. */
export function beatsOf(model: ReadingModel): readonly Beat[] {
  return model.sections.flatMap((section) =>
    section.blocks.flatMap((block) =>
      block.kind === 'beat' ? [block.beat] : block.kind === 'hold' ? block.beats.map((held) => held.beat) : [],
    ),
  );
}
