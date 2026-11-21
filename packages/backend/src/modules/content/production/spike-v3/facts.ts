import { beatsOfV3, type PictureKind, type ScrollDocumentV3 } from '@knowscroll/scroll-model';

/** What an accepted document v3 holds, in numbers: no text of the Scroll. */
export interface SpikeDocumentFacts {
  readonly sections: number;
  readonly beats: number;
  /** The words of the paragraphs (`measures.mainWords`): what the length bound counts. */
  readonly words: number;
  readonly readingMinutes: number;
  readonly picturesByKind: Readonly<Partial<Record<PictureKind, number>>>;
  /** The paragraphs that show a picture. */
  readonly shows: number;
  readonly links: number;
  readonly controls: number;
  readonly asides: number;
  readonly takeawayWords: number;
  /** The kinds the plan named, in order; `null` when the writer chose. */
  readonly plannedKinds: readonly PictureKind[] | null;
  readonly writtenKinds: readonly PictureKind[];
}

const wordsOf = (text: string): number => text.split(/\s+/u).filter((word) => word !== '').length;

/** Measures an accepted document against the plan's picture kinds. Pure. */
export function documentFacts(
  document: ScrollDocumentV3,
  plannedKinds: readonly PictureKind[] | undefined,
): SpikeDocumentFacts {
  const beats = beatsOfV3(document);
  const writtenKinds = document.pictures.map((picture) => picture.kind);
  const picturesByKind: Partial<Record<PictureKind, number>> = {};
  for (const kind of writtenKinds) picturesByKind[kind] = (picturesByKind[kind] ?? 0) + 1;
  return {
    sections: document.sections.length,
    beats: beats.length,
    words: document.measures.mainWords,
    readingMinutes: document.measures.readingMinutes,
    picturesByKind,
    shows: beats.filter((beat) => beat.show !== undefined).length,
    links: beats.reduce((total, beat) => total + beat.links.length, 0),
    controls: beats.filter((beat) => beat.kind === 'plain' && beat.control !== undefined).length,
    asides: document.asides.length,
    takeawayWords: wordsOf(document.takeaway),
    plannedKinds: plannedKinds ?? null,
    writtenKinds,
  };
}
