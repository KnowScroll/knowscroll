/**
 * The one normalization of a source page's visible text (ADR-0031, ADR-0041 §2). Snapshot
 * verification (`scripts/substrate/verify-substrate.ts`), the material a model writes a Scroll from,
 * and every quote checked against either use it; `scripts/substrate/snapshot_source.py`'s
 * `normalize()` mirrors it for the Python snapshot tool. NFC, then every whitespace run (including
 * no-break spaces) to one space. Typography is otherwise preserved exactly.
 */
export function normalizeSnapshotText(text: string): string {
  return text.normalize('NFC').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}
