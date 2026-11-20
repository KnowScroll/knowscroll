import type {
  Aside,
  Beat as DocumentBeat,
  Control,
  Picture,
  PictureState,
  ScrollDocumentV3,
  SectionV3,
  Tone,
} from '@knowscroll/scroll-model';
import { canonicalJson, describePicture, orderedItems, pickItems, scrubPositions } from '../model';
import { blocksOfRun, type RunBeat } from './holds';
import type { Beat, BeatLink, FigureControl, PictureFigure, ReadingBlock, ReadingModel } from './reading-model';

/** A picture in one state as the reader draws it: its words derived from the same data, and a key naming the state. */
export function pictureFigureOf(picture: Picture, state: PictureState): PictureFigure {
  return {
    kind: 'picture',
    picture,
    state,
    alt: describePicture(picture, state),
    key: `${picture.id}/${canonicalJson(state)}`,
  };
}

/** The tone of a picture's part, so a linked phrase is underlined in the colour its part is drawn in. */
function toneOfPart(picture: Picture, part: string): Tone | undefined {
  if (picture.kind === 'cycle' && picture.centre?.id === part) return picture.centre.tone;
  if (picture.kind === 'plan') return picture.places.find((place) => place.id === part)?.tone;
  return orderedItems(picture).find((item) => item.id === part)?.tone;
}

function controlOf(control: Control, picture: Picture, state: PictureState): FigureControl {
  switch (control.kind) {
    case 'scrub':
      return { kind: 'scrub', label: control.label, positions: scrubPositions(picture, state, control.along) };
    case 'switch':
      return { kind: 'switch', label: control.label, to: control.to };
    case 'pick':
      return {
        kind: 'pick',
        label: control.label,
        items: pickItems(picture).map((item) => ({ id: item.id, label: item.label, note: item.note ?? '' })),
      };
  }
}

/** An aside of a document v3, as the reader's side note: the same fields, anchored to a beat instead of a stop. */
function noteOf(aside: ScrollDocumentV3['asides'][number]): Aside {
  return {
    id: aside.id,
    kind: aside.kind,
    title: aside.title,
    text: aside.text,
    anchorStop: aside.anchorBeat,
    collapsed: aside.collapsed,
  };
}

function beatOf(document: ScrollDocumentV3, beat: DocumentBeat, onScreen: Picture | undefined): Beat {
  const links: BeatLink[] =
    onScreen === undefined
      ? []
      : beat.links.map((link) => ({ phrase: link.phrase, part: link.part, tone: toneOfPart(onScreen, link.part) }));
  return {
    id: beat.id,
    kind: beat.kind === 'quote' ? 'quote' : 'prose',
    cite: beat.kind === 'quote' ? beat.cite : undefined,
    text: [{ kind: 'paragraph', text: beat.text }],
    simple: beat.simple,
    links,
    notes: document.asides.filter((aside) => aside.anchorBeat === beat.id).map(noteOf),
  };
}

/**
 * One section's beats and figures. A beat that shows a picture puts the picture after it; beats in a row on one picture
 * share a hold (`blocksOfRun`); a beat with a control has its figure, with the control under it, to itself, because a
 * control under a pinned figure would move as the text moves; a beat that shows nothing keeps the picture before it.
 * Runs end at a section's end: a section starts afresh.
 */
function blocksOfSection(document: ScrollDocumentV3, section: SectionV3): ReadingBlock[] {
  const pictures = new Map(document.pictures.map((picture) => [picture.id, picture]));
  const blocks: ReadingBlock[] = [];
  let run: RunBeat[] = [];
  let onScreen: Picture | undefined;
  const endRun = () => {
    blocks.push(...blocksOfRun(run));
    run = [];
  };
  for (const documentBeat of section.beats) {
    const shown = documentBeat.show === undefined ? undefined : pictures.get(documentBeat.show.picture);
    const beat = beatOf(document, documentBeat, shown ?? onScreen);
    if (documentBeat.show === undefined || shown === undefined) {
      const last = run.at(-1);
      if (last === undefined) blocks.push({ kind: 'beat', beat });
      else run.push({ beat, figure: last.figure, changes: false });
      continue;
    }
    onScreen = shown;
    const figure = pictureFigureOf(shown, documentBeat.show.state);
    if (documentBeat.kind === 'plain' && documentBeat.control !== undefined) {
      endRun();
      blocks.push(
        { kind: 'beat', beat },
        {
          kind: 'figure',
          id: `figure-${beat.id}`,
          figure,
          control: controlOf(documentBeat.control, shown, documentBeat.show.state),
        },
      );
      continue;
    }
    const last = run.at(-1);
    if (last !== undefined && last.figure.kind === 'picture' && last.figure.picture.id !== shown.id) endRun();
    run.push({ beat, figure, changes: true });
  }
  endRun();
  return blocks;
}

/**
 * A `scroll-document.v3` as an essay (Folio README 3, #762). Every layout choice is made here from the document alone:
 * its sections with their titles, a figure after each beat that shows a picture, holds over runs on one picture, a
 * control under its own figure, linked phrases with the colour of their parts, quote beats, and the end plate with the
 * takeaway as "To sum up" and the limits aside as Small print. Ids are the document's own beat ids, so reading
 * evidence, a kept place, Ask and Report name beats.
 */
export function readingModelOfV3(document: ScrollDocumentV3): ReadingModel {
  const smallPrint = document.asides.find((aside) => aside.kind === 'limits');
  return {
    assetId: document.assetId,
    revision: document.revision,
    kicker: document.kicker,
    title: document.title,
    dek: document.dek,
    sections: document.sections.map((section) => ({
      id: section.id,
      heading: section.title,
      blocks: blocksOfSection(document, section),
    })),
    end: {
      takeaway: [document.takeaway],
      smallPrint: smallPrint === undefined ? undefined : { title: smallPrint.title, text: smallPrint.text },
    },
  };
}
