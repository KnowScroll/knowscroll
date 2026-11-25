import { NOTE_PLACES_NAMED, repairNotesV3, type NoteFinding } from './repair-notes-v3.js';

/** The most places with no room for their line that are named in the closing line; the others are counted. */
export const COPY_NOTE_PLACES = NOTE_PLACES_NAMED;

/** A copy finding of the document v3 compile: where it is in the model's reply, and what it says about the copy (`copyDetailV3`). */
export interface CopyFinding {
  /** The model's own path (`items.11`, `pictures.0`, `items.8.title`). */
  readonly path: string;
  /** The part and the research's words, from the compile; never words the model wrote. */
  readonly detail: string;
}

/**
 * What the writer's repairs are told about a draft refused for `copied_passage` (D-441): for each place in the model's reply,
 * the part of it that copies and the research's words that it copies. The same notes as `repairNotesV3` with no figure to name
 * (that one also carries the figures of D-444); see it for how the notes fit the harness's limit. `undefined` when there is no
 * copy finding.
 */
export function copyRepairNotesV3(findings: readonly CopyFinding[]): string | undefined {
  return repairNotesV3(findings satisfies readonly NoteFinding[], []);
}
