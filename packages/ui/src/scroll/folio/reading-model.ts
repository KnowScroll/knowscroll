import type { Aside, Guide, Interactive, Picture, PictureState, QuoteCite, Tone } from '@knowscroll/scroll-model';

/**
 * What the Folio reader draws: an essay as sections of beats and figures. The reader knows no document version;
 * an adapter per version builds this (`from-v2.ts`, `from-v3.ts`). Ids are the document's own unit ids, so reading evidence, a
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

/**
 * A phrase of a beat that names a part of the figure on screen (document v3). The reader underlines it in the part's
 * colour (`tone`, else the page's link colour) and pulses the part when it is pressed.
 */
export interface BeatLink {
  readonly phrase: string;
  readonly part: string;
  readonly tone?: Tone | undefined;
}

/** One unit of reading: what is read in one go, and what reading evidence names. */
export interface Beat {
  /** The document's unit id: a v2 stop id, or a document v3 beat id. */
  readonly id: string;
  /** A question is a call drawn as text: its prompt, then its explanation. A quote is a quotation set apart. */
  readonly kind: 'prose' | 'question' | 'quote';
  /** Who said a quotation, where and when. */
  readonly cite?: QuoteCite | undefined;
  /** Phrases that name parts of the figure on screen. */
  readonly links?: readonly BeatLink[] | undefined;
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

/** A picture of a document v3 in one state, its words (derived by code) and a key naming that state. */
export interface PictureFigure {
  readonly kind: 'picture';
  readonly picture: Picture;
  readonly state: PictureState;
  readonly alt: string;
  readonly key: string;
}

/** What a figure draws: a picture of a document v3. A v2 Scroll has no figure any more: its drawing kits are deleted (#835). */
export type Figure = PictureFigure;

/**
 * A control under a figure: `scrub` steps through positions, `switch` flips to one other state, `pick` reads the note of
 * an item. Each has buttons and keys, and a sentence for its state; nothing a reader does with one is reported (D-209).
 * The v2 `tilt` is gone with Earth & sky's picture (#835); a stored Final call may still name it, and it is not read.
 */
export type FigureControl =
  | {
      readonly kind: 'scrub';
      readonly label: string;
      readonly positions: readonly { readonly label: string; readonly state: PictureState }[];
    }
  | { readonly kind: 'switch'; readonly label: string; readonly to: PictureState }
  | {
      readonly kind: 'pick';
      readonly label: string;
      readonly items: readonly { readonly id: string; readonly label: string; readonly note: string }[];
    };

export interface FigureBlock {
  readonly kind: 'figure';
  readonly id: string;
  readonly figure: Figure;
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
  readonly figure: Figure;
}

/** The end of the essay: the takeaway and the picture of the whole journey. The ways on are the screen's. */
export interface EndPlate {
  readonly takeaway: readonly string[];
  readonly figure?: Figure | undefined;
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
