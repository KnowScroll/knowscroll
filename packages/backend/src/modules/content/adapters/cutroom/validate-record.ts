import type { EngineRecord, RunStatus, VideoResult } from './read-client.js';

/** Engine-attested checks are retained as such. They are never independent witness evidence. */
export function validateEngineRecord(status: RunStatus, result: VideoResult, record: EngineRecord): boolean {
  if (
    status.state !== 'finished' ||
    status.resumedBy !== undefined ||
    status.resumes !== undefined ||
    status.runId !== result.runId ||
    status.runId !== record.runId ||
    status.requestId !== result.requestId
  )
    return false;
  const accepted = (checks: readonly { outcome: string }[]) => checks.every((check) => check.outcome !== 'fail');
  const chosen = record.pictures.filter((picture) => picture.chosen);
  const used = record.takes.filter((take) => take.used);
  if (
    chosen.length === 0 ||
    used.length === 0 ||
    new Set(chosen.map((p) => p.shotId)).size !== chosen.length ||
    new Set(used.map((p) => p.shotId)).size !== used.length
  )
    return false;
  for (const picture of chosen) {
    if (picture.keptFrom !== undefined || !accepted(picture.checks)) return false;
    for (const step of ['technical', 'text', 'witness', 'reconcile'])
      if (!picture.checks.some((check) => check.gate === '1' && check.step === step && check.outcome !== 'fail'))
        return false;
  }
  for (const take of used) {
    // Pinned Cutroom permits unpictured, text-to-video shots (D-027, S-150).
    // `used` attests inclusion in the completed render; wire v1 exposes no take mode or picture join.
    if (take.keptFrom !== undefined || !accepted(take.checks)) return false;
    for (const gate of ['2', '3', '4', '5'])
      if (!take.checks.some((check) => check.gate === gate && check.outcome !== 'fail')) return false;
  }
  if (JSON.stringify(record.degradations) !== JSON.stringify(result.degradations)) return false;
  return (
    result.stills.length === chosen.length &&
    result.stills.every(
      (still) =>
        chosen.some((picture) => picture.pictureId === still.pictureId && picture.shotId === still.shotId) &&
        (used.some((take) => take.shotId === still.shotId) ||
          record.degradations.some((d) => d.shotId === still.shotId)),
    )
  );
}
