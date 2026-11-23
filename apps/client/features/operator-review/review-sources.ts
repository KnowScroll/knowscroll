import type { ReviewShow } from '@knowscroll/contracts';
import type { ScrollDocumentV2, ScrollDocumentV3 } from '@knowscroll/scroll-model';

/** A passage a part cites, word for word, and the title of the page it comes from. */
export interface SourcedPassage {
  readonly quote: string;
  readonly source: string;
}

/** One part of the Scroll with what it cites and a name an operator can find it by. */
export interface SourcedPart {
  readonly partId: string;
  readonly label: string;
  readonly passages: readonly SourcedPassage[];
}

/** Where the cited passages go on the page: under the beat they belong to, and the rest at the end. */
export interface SourcesIndex {
  /** The parts to draw under a beat or stop: its own, then the asides anchored to it. */
  readonly under: (beatId: string) => readonly SourcedPart[];
  /** The parts no beat carries (a picture, the end summary), in the order the provenance gave them. */
  readonly rest: readonly SourcedPart[];
  /** A name for any part id, for a sentence the support check points at. */
  readonly labelOf: (partId: string) => string;
}

/** The first words of a text, for naming a beat. */
function openingWords(text: string, count = 6): string {
  const words = text.trim().split(/\s+/u);
  return words.length <= count ? words.join(' ') : `${words.slice(0, count).join(' ')}…`;
}

/** What the document says of its parts, whichever schema it is: the units in reading order, the asides and the pictures. */
interface PartFacts {
  readonly units: readonly { readonly id: string; readonly label: string }[];
  readonly asides: readonly { readonly id: string; readonly anchor: string; readonly title: string }[];
  readonly pictures: readonly { readonly id: string; readonly title: string }[];
}

function factsOf(document: ScrollDocumentV2 | ScrollDocumentV3): PartFacts {
  if ('sections' in document) {
    const beats = document.sections.flatMap((section) => section.beats);
    return {
      units: beats.map((beat, index) => ({
        id: beat.id,
        label: `Beat ${String(index + 1)}: ${openingWords(beat.text)}`,
      })),
      asides: document.asides.map((aside) => ({ id: aside.id, anchor: aside.anchorBeat, title: aside.title })),
      pictures: document.pictures.map((picture) => ({ id: picture.id, title: picture.title })),
    };
  }
  return {
    units: document.stops.map((stop, index) => ({ id: stop.id, label: `Stop ${String(index + 1)}` })),
    asides: document.asides.map((aside) => ({ id: aside.id, anchor: aside.anchorStop, title: aside.title })),
    pictures: [],
  };
}

/**
 * Sorts the passages each part cites onto the page. A beat (a stop, for a v2 Scroll) carries its own and those of the asides
 * anchored to it; a picture, the document v3's end summary and a v2 Scroll's recap come after the essay. Pure.
 */
export function sourcesIndexOf(
  document: ScrollDocumentV2 | ScrollDocumentV3,
  parts: ReviewShow['parts'],
): SourcesIndex {
  const facts = factsOf(document);
  const names = new Map<string, string>([
    ['title', 'Title'],
    ['dek', 'Opening line'],
    ['recap', 'Recap'],
    ['takeaway', 'To sum up'],
    ...facts.units.map((unit) => [unit.id, unit.label] as const),
    ...facts.asides.map((aside) => [aside.id, `Aside: ${aside.title}`] as const),
    ...facts.pictures.map((picture) => [picture.id, `Picture: ${picture.title}`] as const),
  ]);
  const labelOf = (partId: string) => names.get(partId) ?? partId;
  const cited = new Map(parts.map((part) => [part.partId, part.passages]));
  const sourced = (partId: string): SourcedPart[] => {
    const passages = cited.get(partId);
    return passages === undefined ? [] : [{ partId, label: labelOf(partId), passages }];
  };
  const placed = new Set<string>();
  const underBeat = new Map<string, SourcedPart[]>();
  for (const unit of facts.units) {
    const own = [
      ...sourced(unit.id),
      ...facts.asides.filter((aside) => aside.anchor === unit.id).flatMap((aside) => sourced(aside.id)),
    ];
    for (const part of own) placed.add(part.partId);
    underBeat.set(unit.id, own);
  }
  return {
    under: (beatId) => underBeat.get(beatId) ?? [],
    rest: parts.flatMap((part) => (placed.has(part.partId) ? [] : sourced(part.partId))),
    labelOf,
  };
}
