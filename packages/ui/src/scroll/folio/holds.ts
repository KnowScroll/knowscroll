import type { HeldBeat, ReadingBlock } from './reading-model';

/**
 * The hold rule every document version shares (Folio README 3.8): beats in a row on one picture, two or more of them
 * changing it, share a figure that holds while they pass, at most `HOLD_LIMIT` beats; a fourth starts a new figure. Each
 * version's adapter decides what "one picture" means (a document v3 picture) and cuts the runs; this file
 * turns a run into blocks.
 */

/** A figure holds for at most this many beats: more would turn the page back into a slot under a picture. */
export const HOLD_LIMIT = 3;

/** A read beat in a run on one picture: the figure it shows, and whether the beat itself changed it. */
export interface RunBeat extends HeldBeat {
  readonly changes: boolean;
}

/** One stretch of a run, drawn as a hold when two or more of its beats change the figure, else as beats and figures. */
function blocksOfChunk(chunk: readonly RunBeat[]): ReadingBlock[] {
  const [first] = chunk;
  if (first !== undefined && chunk.filter((held) => held.changes).length >= 2) {
    return [{ kind: 'hold', id: `hold-${first.beat.id}`, beats: chunk.map(({ beat, figure }) => ({ beat, figure })) }];
  }
  return chunk.flatMap((held): ReadingBlock[] =>
    held.changes
      ? [
          { kind: 'beat', beat: held.beat },
          { kind: 'figure', id: `figure-${held.beat.id}`, figure: held.figure },
        ]
      : [{ kind: 'beat', beat: held.beat }],
  );
}

/**
 * A run of read beats on one picture, starting at a change: cut into stretches of at most `HOLD_LIMIT`. Beats after the
 * last change are not held: a figure that would not change again is not worth pinning.
 */
export function blocksOfRun(run: readonly RunBeat[]): ReadingBlock[] {
  let last = run.length - 1;
  while (last >= 0 && run[last]?.changes === false) last -= 1;
  const held = run.slice(0, last + 1);
  const after = run.slice(last + 1).map((rest): ReadingBlock => ({ kind: 'beat', beat: rest.beat }));
  const blocks: ReadingBlock[] = [];
  for (let start = 0; start < held.length; start += HOLD_LIMIT) {
    blocks.push(...blocksOfChunk(held.slice(start, start + HOLD_LIMIT)));
  }
  return [...blocks, ...after];
}
