import type { ReadStop, ScrollDocumentV2, Stop } from '@knowscroll/scroll-model';
import type { Beat, BeatText, ReadingBlock, ReadingModel } from './reading-model';

type CallStop = Exclude<Stop, ReadStop>;

function notesOf(document: ScrollDocumentV2, stopId: string) {
  return document.asides.filter((aside) => aside.anchorStop === stopId);
}

function proseBeat(document: ScrollDocumentV2, stop: ReadStop): Beat {
  const heading = stop.blocks.find((block) => block.type === 'heading');
  const text = stop.blocks.flatMap((block): BeatText[] =>
    block.type === 'heading' ? [] : [{ kind: block.type === 'line' ? 'line' : 'paragraph', text: block.text }],
  );
  return {
    id: stop.id,
    kind: 'prose',
    heading: heading?.text,
    text,
    simple: stop.simple,
    guide: stop.guide,
    play: stop.interactive,
    notes: notesOf(document, stop.id),
  };
}

/** A call as text: its question, then why the answer is what it is. Every call can be read without answering (D-397). */
function questionBeat(document: ScrollDocumentV2, stop: CallStop): Beat {
  return {
    id: stop.id,
    kind: 'question',
    text: [
      { kind: 'line', text: stop.prompt },
      { kind: 'paragraph', text: stop.explain },
    ],
    simple: stop.simple,
    notes: notesOf(document, stop.id),
  };
}

/**
 * A `scroll-document.v2` as an essay (folio README 5.5). Every layout choice is made here from the document alone,
 * so the server sends nothing new:
 *
 * - a read stop is a beat; a call is a question beat, drawn as text with no options;
 * - the end plate takes the recap's captions and the small print;
 * - a v2 Scroll has **no figure**. Its stage named a drawing kit, and the last of them is deleted (#835), so a stored stage
 *   (of any of the nine kits) is parsed and served but not drawn: its beats read as text, exactly as a Scroll with no stage
 *   does. The stage is never read here, so no stored stage can make this throw; a Final call's stored `tilt` binding is not
 *   acted on either (D-432: v3 has `scrub`, `switch` and `pick`).
 */
export function readingModelOfV2(document: ScrollDocumentV2): ReadingModel {
  const blocks: ReadingBlock[] = document.stops.map((stop) => ({
    kind: 'beat',
    beat: stop.kind === 'read' ? proseBeat(document, stop) : questionBeat(document, stop),
  }));
  const smallPrint = document.asides.find((aside) => aside.id === document.recap.smallPrintAside);
  return {
    assetId: document.assetId,
    revision: document.revision,
    kicker: document.kicker,
    title: document.title,
    dek: document.dek,
    sections: [{ id: 'essay', blocks }],
    end: {
      takeaway: document.recap.captions,
      smallPrint: smallPrint === undefined ? undefined : { title: smallPrint.title, text: smallPrint.text },
    },
  };
}
