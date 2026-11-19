import type { ReadStop, ScrollDocumentV2, Stop } from '@knowscroll/scroll-model';
import { KIT_PICTURES } from '../kit';
import type { FigureState } from '../stage/kit-figure';
import { stageFigureAt } from '../stage/stage-figure';
import { blocksOfRun, type RunBeat } from './holds';
import type { Figure } from './reading-model';
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

/** Whether the kit draws a move between two figures as one picture changing, the test for sharing a hold. */
function sameView(from: Figure, to: Figure): boolean {
  if (from.kind !== 'state' || to.kind !== 'state' || from.kit !== to.kit) return false;
  const kit = KIT_PICTURES[from.kit];
  return kit.canTween(kit.sceneOf(from.state), kit.sceneOf(to.state));
}

/**
 * A `scroll-document.v2` as an essay (folio README 5.5). Every layout choice is made here from the document alone,
 * so the server sends nothing new:
 *
 * - a read stop is a beat; a call is a question beat, drawn as text with no options;
 * - a stop that changes the picture puts the picture after it;
 * - beats in a row on one view of the picture (the kit draws a move between them as one picture moving), two or more of
 *   them changing it, share a hold of at most `HOLD_LIMIT` beats; a beat inside it that changes nothing keeps the
 *   state before it;
 * - a Final call that hands the reader Earth's tilt (D-187) puts the picture after it, with the slider under it;
 * - the end plate takes the recap's captions and the picture of the whole journey, when the kit draws one.
 */
export function readingModelOfV2(document: ScrollDocumentV2): ReadingModel {
  const { stage, stops } = document;
  const changesAt = new Set(stage?.states.map((entry) => entry.stop));
  const blocks: ReadingBlock[] = [];
  let run: RunBeat[] = [];
  const endRun = () => {
    blocks.push(...blocksOfRun(run));
    run = [];
  };
  for (const stop of stops) {
    if (stop.kind !== 'read') {
      endRun();
      blocks.push({ kind: 'beat', beat: questionBeat(document, stop) });
      if (stage !== undefined && stop.kind === 'final_call' && stop.binding?.kind === 'tilt') {
        const figure = stageFigureAt(stage, stops, stop.id);
        blocks.push({ kind: 'figure', id: `figure-${stop.id}`, figure, control: { kind: 'tilt' } });
      }
      continue;
    }
    const beat = proseBeat(document, stop);
    const changes = changesAt.has(stop.id);
    if (stage === undefined || (!changes && run.length === 0)) {
      blocks.push({ kind: 'beat', beat });
      continue;
    }
    const figure = stageFigureAt(stage, stops, stop.id);
    const last = run.at(-1);
    if (last !== undefined && !sameView(last.figure, figure)) endRun();
    if (!changes && run.length === 0) blocks.push({ kind: 'beat', beat });
    else run.push({ beat, figure, changes });
  }
  endRun();
  const smallPrint = document.asides.find((aside) => aside.id === document.recap.smallPrintAside);
  const lastStop = stops.at(-1);
  // Only the picture of the whole journey earns a place at the end: the last state was just shown.
  const journey =
    stage === undefined || lastStop === undefined ? undefined : stageFigureAt(stage, stops, lastStop.id, true);
  return {
    assetId: document.assetId,
    revision: document.revision,
    kicker: document.kicker,
    title: document.title,
    dek: document.dek,
    sections: [{ id: 'essay', blocks }],
    end: {
      takeaway: document.recap.captions,
      figure: journey?.kind === 'recap' ? journey : undefined,
      smallPrint: smallPrint === undefined ? undefined : { title: smallPrint.title, text: smallPrint.text },
    },
  };
}
