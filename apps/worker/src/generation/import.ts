/**
 * ADR-0023 section 4 — verified local-host import and the immutable generated-Reel record.
 *
 * `importFinishedVideo` is a pure, reusable filesystem module: no HTTP, no database, no worker
 * loop. It never trusts an engine-reported path (ADR-0007/ADR-0020: engine paths are untrusted
 * host metadata with no retention promise), and it never leaves a half-imported asset — every exit
 * is either a fully installed, content-addressed file or no file at all, with a typed reason.
 *
 * `recordImportedReel` is the one place that writes the `media_object`/`generated_reel` rows; it
 * commits both in a single transaction and relies on migration 0013's own guards (unique
 * `attempt_id`, the lineage trigger) to make a repeat call and a lineage mismatch both fail safely.
 *
 * This file does not dispatch to Cutroom, does not run a job loop, and does not decide when an
 * attempt is finished — a later stage supplies that wiring (see the brief for this lane).
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import {
  checkContainment,
  checkRegularFile,
  fsyncDirectory,
  installAtContentAddress,
  MAX_MEDIA_BYTES,
  readMp4BoxOrder,
  streamCopyWithHash,
} from './media-store.ts';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------------------------
// importFinishedVideo
// ---------------------------------------------------------------------------------------------

export interface ImportFinishedVideoInput {
  attemptId: string;
  runId: string;
  enginePath: string;
  engineArtifactRoot: string;
  mediaRoot: string;
  /**
   * Test-only override of the 512 MiB contract ceiling, so a test can simulate an oversized file
   * without actually writing one. Always clamped downward: this can never raise the real ceiling.
   */
  maxBytes?: number;
}

export type ImportRefusalReason =
  | 'engine_path_not_absolute'
  | 'engine_artifact_root_unresolvable'
  | 'engine_path_missing'
  | 'engine_path_not_contained'
  | 'engine_path_is_symlink'
  | 'engine_path_is_directory'
  | 'engine_path_not_regular_file'
  | 'engine_file_empty'
  | 'engine_file_too_large'
  | 'probe_not_mp4'
  | 'probe_missing_video_stream'
  | 'probe_video_codec_not_h264'
  | 'probe_audio_codec_not_aac'
  | 'probe_aspect_ratio_not_9_16'
  | 'probe_duration_out_of_range'
  | 'probe_not_progressive'
  | 'probe_failed'
  | 'io_error';

export interface ProbeSummary {
  formatName: string;
  majorBrand: string | null;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  progressive: boolean;
}

export type ImportOutcome =
  | { ok: true; sha256: string; byteSize: number; storageKey: string; probe: ProbeSummary }
  | { ok: false; reason: ImportRefusalReason };

function refuse(reason: ImportRefusalReason): { ok: false; reason: ImportRefusalReason } {
  return { ok: false, reason };
}

// The stated tolerance for "9:16": within 2% of the 9/16 ratio. A caller that needs a different
// tolerance is a contract change, not a runtime parameter — this module keeps it fixed and named.
const ASPECT_TARGET = 9 / 16;
const ASPECT_TOLERANCE_RATIO = 0.02;
const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 120;

function withinAspectTolerance(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const ratio = width / height;
  return Math.abs(ratio - ASPECT_TARGET) <= ASPECT_TARGET * ASPECT_TOLERANCE_RATIO;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}
interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  tags?: { major_brand?: string };
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

async function ffprobeJson(path: string): Promise<FfprobeOutput | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return null;
  }
}

type ProbeCheck = { ok: true; probe: ProbeSummary } | { ok: false; reason: ImportRefusalReason };

/**
 * Requires MP4 with an H.264 video stream, AAC audio when audio is present, 9:16 within the stated
 * tolerance, duration between 5 and 120 seconds, and `moov` before `mdat` (progressive). `format_name`
 * alone cannot distinguish MP4 from a plain MOV under ffmpeg's shared demuxer, so this also checks
 * `major_brand` is not the QuickTime brand (`qt  `); that is a real, if imperfect, limit of ffprobe.
 */
async function probeVideo(path: string): Promise<ProbeCheck> {
  const data = await ffprobeJson(path);
  if (!data || !data.format) return { ok: false, reason: 'probe_failed' };
  const formatName = data.format.format_name ?? '';
  const majorBrand = data.format.tags?.major_brand?.trim() ?? null;
  const looksLikeMp4 = formatName.split(',').includes('mp4') && majorBrand !== 'qt';
  if (!looksLikeMp4) return { ok: false, reason: 'probe_not_mp4' };

  const streams = data.streams ?? [];
  const video = streams.find((entry) => entry.codec_type === 'video');
  if (!video) return { ok: false, reason: 'probe_missing_video_stream' };
  if (video.codec_name !== 'h264') return { ok: false, reason: 'probe_video_codec_not_h264' };
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  if (!withinAspectTolerance(width, height)) return { ok: false, reason: 'probe_aspect_ratio_not_9_16' };

  const audio = streams.find((entry) => entry.codec_type === 'audio');
  if (audio && audio.codec_name !== 'aac') return { ok: false, reason: 'probe_audio_codec_not_aac' };

  const durationSeconds = data.format.duration !== undefined ? Number(data.format.duration) : NaN;
  if (!Number.isFinite(durationSeconds)) return { ok: false, reason: 'probe_failed' };
  if (durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) {
    return { ok: false, reason: 'probe_duration_out_of_range' };
  }

  const boxOrder = await readMp4BoxOrder(path);
  const progressive = boxOrder.moovOffset !== null && (boxOrder.mdatOffset === null || boxOrder.moovOffset < boxOrder.mdatOffset);
  if (!progressive) return { ok: false, reason: 'probe_not_progressive' };

  return {
    ok: true,
    probe: {
      formatName,
      majorBrand,
      durationSeconds,
      width,
      height,
      videoCodec: video.codec_name ?? 'unknown',
      audioCodec: audio?.codec_name ?? null,
      progressive,
    },
  };
}

/**
 * Verified local-host import (ADR-0023 section 4), in this exact order: reject a non-absolute
 * engine path; require the realpath of `enginePath` to sit strictly inside the realpath of
 * `engineArtifactRoot`; require `lstat` to show a regular file (never a symlink, never a
 * directory); require a non-empty size within the ceiling; stream-copy into a temp file under
 * `mediaRoot` while hashing; fsync; probe with ffprobe; and only then atomically rename to the
 * content-addressed key. Every early exit before the final rename leaves no file behind; a
 * pre-existing destination (the same bytes imported before) short-circuits the write instead of
 * duplicating it.
 */
export async function importFinishedVideo(input: ImportFinishedVideoInput): Promise<ImportOutcome> {
  const { attemptId, enginePath, engineArtifactRoot, mediaRoot } = input;
  if (!isAbsolute(engineArtifactRoot)) throw new Error('engineArtifactRoot must be an absolute path (deployment configuration, not per-attempt data)');
  if (!isAbsolute(mediaRoot)) throw new Error('mediaRoot must be an absolute path (deployment configuration, not per-attempt data)');

  const containment = await checkContainment(engineArtifactRoot, enginePath);
  if (!containment.ok) {
    switch (containment.reason) {
      case 'not_absolute':
        return refuse('engine_path_not_absolute');
      case 'root_unresolvable':
        return refuse('engine_artifact_root_unresolvable');
      case 'path_unresolvable':
        return refuse('engine_path_missing');
      case 'not_contained':
        return refuse('engine_path_not_contained');
    }
  }

  const kind = await checkRegularFile(enginePath);
  if (!kind.ok) {
    switch (kind.reason) {
      case 'missing':
        return refuse('engine_path_missing');
      case 'symlink':
        return refuse('engine_path_is_symlink');
      case 'directory':
        return refuse('engine_path_is_directory');
      case 'other':
        return refuse('engine_path_not_regular_file');
    }
  }

  if (kind.sizeBytes <= 0) return refuse('engine_file_empty');
  const ceiling = Math.min(input.maxBytes ?? MAX_MEDIA_BYTES, MAX_MEDIA_BYTES);
  if (kind.sizeBytes > ceiling) return refuse('engine_file_too_large');

  const tmpDirectory = join(mediaRoot, 'tmp');
  await mkdir(tmpDirectory, { recursive: true });
  const tempPath = join(tmpDirectory, `import-${attemptId}-${randomUUID()}.mp4.tmp`);

  let cleanupTemp = true;
  try {
    let copy;
    try {
      copy = await streamCopyWithHash(enginePath, tempPath);
      await fsyncDirectory(dirname(tempPath));
    } catch {
      return refuse('io_error');
    }

    const probed = await probeVideo(tempPath).catch((): ProbeCheck => ({ ok: false, reason: 'probe_failed' }));
    if (!probed.ok) return refuse(probed.reason);

    const stored = await installAtContentAddress(tempPath, mediaRoot, copy.sha256);
    cleanupTemp = false; // installAtContentAddress has already consumed or renamed the temp file
    return { ok: true, sha256: copy.sha256, byteSize: copy.byteSize, storageKey: stored.storageKey, probe: probed.probe };
  } catch {
    return refuse('io_error');
  } finally {
    if (cleanupTemp) await rm(tempPath, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// recordImportedReel
// ---------------------------------------------------------------------------------------------

export interface RecordedMedia {
  sha256: string;
  byteSize: number;
  /** The probe summary from a successful `importFinishedVideo` call; stored as `media_object.probe`. */
  probe: unknown;
  storageKey: string;
}

export interface GeneratedReelLineage {
  briefSha256: string;
  contractRevision: string;
  runId: string;
  /** e.g. Cutroom's own record summary: take/used counts and degradations. Never all attempts. */
  recordSummary: unknown;
}

export interface RecordImportedReelInput {
  attemptId: string;
  briefId: string;
  engineId: string;
  cutroomRunId: string;
  /** Must equal the engine's own declared provider mode; the lineage guard enforces this. */
  providerMode: 'standin' | 'live';
  /** The exact untrusted engine path the finished attempt's result declared for this video. */
  enginePath: string;
  media: RecordedMedia;
  lineage: GeneratedReelLineage;
}

export type RecordImportedReelOutcome =
  | { ok: true; generatedReelId: string; created: boolean }
  | { ok: false; reason: 'lineage_mismatch' };

const LINEAGE_ERROR_PATTERN = /lineage/i;

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}

/**
 * Inserts `media_object` and the immutable `generated_reel` row in one transaction. Migration
 * 0013's `generated_reel_lineage_guard` trigger is the actual authority for whether this attempt,
 * job, brief, engine and provider mode line up; a rejection from that trigger is reported as
 * `lineage_mismatch` rather than a raw database error. The unique `attempt_id` is the fence: a
 * second call with the same `attemptId` finds the existing row (via `ON CONFLICT DO NOTHING`,
 * which still runs the lineage trigger first) and returns it with `created:false` instead of
 * erroring or inserting a duplicate.
 */
export async function recordImportedReel(client: pg.PoolClient, input: RecordImportedReelInput): Promise<RecordImportedReelOutcome> {
  assertNonEmptyString(input.attemptId, 'attemptId');
  assertNonEmptyString(input.briefId, 'briefId');
  assertNonEmptyString(input.engineId, 'engineId');
  assertNonEmptyString(input.cutroomRunId, 'cutroomRunId');
  assertNonEmptyString(input.enginePath, 'enginePath');
  if (input.providerMode !== 'standin' && input.providerMode !== 'live') throw new Error('providerMode must be "standin" or "live"');
  if (!/^[0-9a-f]{64}$/.test(input.media.sha256)) throw new Error('media.sha256 must be 64 lowercase hex characters');
  if (!Number.isSafeInteger(input.media.byteSize) || input.media.byteSize <= 0) throw new Error('media.byteSize must be a positive integer');

  const candidateId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key)
       VALUES($1,$2,'video/mp4',$3,$4)
       ON CONFLICT (sha256) DO NOTHING`,
      [input.media.sha256, input.media.byteSize, JSON.stringify(input.media.probe), input.media.storageKey],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthesis',true,$9)
       ON CONFLICT (attempt_id) DO NOTHING
       RETURNING id`,
      [
        candidateId,
        input.attemptId,
        input.briefId,
        input.engineId,
        input.cutroomRunId,
        input.media.sha256,
        input.enginePath,
        input.providerMode,
        JSON.stringify(input.lineage),
      ],
    );
    if (inserted.rowCount === 1) {
      await client.query('COMMIT');
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('unreachable: rowCount was 1 with no row');
      return { ok: true, generatedReelId: row.id, created: true };
    }
    const existing = await client.query<{ id: string }>('SELECT id FROM generated_reel WHERE attempt_id=$1', [input.attemptId]);
    await client.query('COMMIT');
    const existingId = existing.rows[0]?.id;
    if (existingId === undefined) throw new Error('generated_reel insert produced neither a new row nor an existing one for this attempt');
    return { ok: true, generatedReelId: existingId, created: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof Error && LINEAGE_ERROR_PATTERN.test(error.message)) return { ok: false, reason: 'lineage_mismatch' };
    throw error;
  }
}
