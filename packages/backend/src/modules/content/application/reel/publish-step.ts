import { checkEngineRecord, type ChainReport, type ChainRun } from '../../domain/reel/chain.js';
import { approvalReference } from '../../domain/reel/script.js';
import { checkAgainstWorld, recipeOf, type LintedScript } from './assess.js';
import type { InstalledReel, ReelPorts, TwinScroll } from './ports.js';

/** Cutroom's pinned revision (CF-61): the wire contract the Reel was made under. */
const CONTRACT_REVISION = '94ee04a1c48069c293203de326d4801360ca6158';

/** Where a Reel in this world came from: this world's own order, or another world's. */
export type ReelOrigin =
  | { readonly kind: 'ordered'; readonly orderId: string; readonly take: number; readonly ceilingCents: number }
  | { readonly kind: 'received'; readonly orderedBy: string; readonly take: number; readonly ceilingCents: number };

export type FinishedChain = Extract<ChainReport, { kind: 'finished' }>;

export interface PublishInput {
  readonly linted: LintedScript;
  readonly origin: ReelOrigin;
  readonly requestId: string;
  readonly runs: readonly ChainRun[];
  readonly report: FinishedChain;
}

/**
 * `held`: nothing is decided. Either something is not ready (a file not readable yet, a Scroll not
 * published here yet, Cutroom unreachable) or something does not add up and a person should look
 * (the engine's record disagrees with its result). The claim stays open.
 * `refused`: the Reel is made and will never be published, and its money is spent.
 */
export type PublishOutcome =
  | { readonly kind: 'published'; readonly assetId: string; readonly created: boolean }
  | { readonly kind: 'held'; readonly code: string }
  | { readonly kind: 'refused'; readonly code: string };

function provenanceOf(
  p: Pick<ReelPorts, 'world'>,
  input: PublishInput,
  twin: TwinScroll,
  media: InstalledReel,
  record: unknown,
): Record<string, unknown> {
  const { script } = input.linted;
  return {
    schemaVersion: 'reel-provenance.v1',
    kind: 'cutroom_import',
    script: script.id,
    approval: script.approval,
    approvalReference: approvalReference(script),
    brief: script.brief,
    recipe: script.recipe,
    twin: { assetId: twin.assetId, assetRevision: twin.revision, explanationUnitId: twin.explanationUnitId },
    requestId: input.requestId,
    take: input.origin.take,
    ceilingCents: input.origin.ceilingCents,
    orderedBy: input.origin.kind === 'ordered' ? p.world : input.origin.orderedBy,
    receivedBy: input.origin.kind === 'received' ? p.world : undefined,
    runIds: input.report.runIds,
    runId: input.report.finalRunId,
    contractRevision: CONTRACT_REVISION,
    witness: { label: 'engine-attested, not independent', record },
    reportedCostCents: input.report.costCents,
    mediaSha256: media.sha256,
    probe: media.probe,
    fixture: false,
  };
}

/** What makes a made Reel unpublishable for good: the engine's own failed checks, a media file that is not a Reel, a repeat. */
const FINAL_REFUSALS = new Set([
  'record_picture',
  'record_take',
  'media_profile_refused',
  'media_faststart_refused',
  'artifact_size',
  'repetition',
]);

const outcomeOf = (code: string): PublishOutcome => ({ kind: FINAL_REFUSALS.has(code) ? 'refused' : 'held', code });

/**
 * Turns a finished, completed request into a Reel in this world: the engine's own record is
 * checked, the twin Scroll must be here, the video is copied into the media store and probed, and
 * one transaction admits the asset. Idempotent: the same run gives the same asset.
 *
 * No network call or file copy happens inside a database transaction; the media is installed
 * first and only then the short admission transaction runs.
 */
export async function publishFinishedReel(p: ReelPorts, input: PublishInput): Promise<PublishOutcome> {
  const { report, runs, linted } = input;
  const tip = report.tip;
  if (tip.until !== 'video' || tip.videoPath === undefined) return outcomeOf('result_without_video');
  const answered = await p.engine.record(report.finalRunId);
  if (answered.kind !== 'finished') return { kind: 'held', code: 'engine_unreachable' };
  const verdict = checkEngineRecord(tip, answered.record, runs.at(-1)?.status.resumes);
  if (verdict !== 'ok') return outcomeOf(verdict);
  const world = await checkAgainstWorld(p, linted);
  if (world.kind === 'refused') return outcomeOf(world.code);
  const installed = await p.media.install({ path: tip.videoPath, runId: report.finalRunId });
  if (installed.kind !== 'installed') return outcomeOf(installed.code);
  const published = await p.publisher.publish({
    scriptName: linted.name,
    script: linted.script,
    twin: world.twin,
    topicId: recipeOf(linted.script).topicId,
    media: installed.media,
    provenance: provenanceOf(p, input, world.twin, installed.media, answered.record),
    orderId: input.origin.kind === 'ordered' ? input.origin.orderId : undefined,
    runId: report.finalRunId,
  });
  return published.kind === 'published' ? published : outcomeOf(published.code);
}
