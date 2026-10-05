/**
 * ADR-0023 section 4 — verified local-host import. Entry module: the filesystem half lives here,
 * the ffprobe policy in `import/probe.ts` and the database record in `@knowscroll/db/generation/import`.
 *
 * `importFinishedVideo` never trusts an engine-reported path (ADR-0007/ADR-0020: engine paths are
 * untrusted host metadata with no retention promise), and it never leaves a half-imported asset —
 * every exit is either a fully installed, content-addressed file or no file at all, with a typed
 * reason. It does no HTTP, no database and no job loop.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type ImportRefusalReason,
  type ProbeCheck,
  type ProbeSummary,
  probeVideo,
} from './import/probe.ts';
import {
  checkContainment,
  checkRegularFile,
  fsyncDirectory,
  installAtContentAddress,
  MAX_MEDIA_BYTES,
  streamCopyWithHash,
} from './media-store.ts';

export { recordImportedReel } from '@knowscroll/db/generation/import';
/** Re-exported for existing importers; the profile itself lives in `media-profile.ts`. */

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

export type ImportOutcome =
  | {
      ok: true;
      sha256: string;
      byteSize: number;
      storageKey: string;
      probe: ProbeSummary;
    }
  | { ok: false; reason: ImportRefusalReason };

function refuse(reason: ImportRefusalReason): {
  ok: false;
  reason: ImportRefusalReason;
} {
  return { ok: false, reason };
}

// The stated tolerance for "9:16": within 2% of the 9/16 ratio. A caller that needs a different

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
export async function importFinishedVideo(
  input: ImportFinishedVideoInput,
): Promise<ImportOutcome> {
  const { attemptId, enginePath, engineArtifactRoot, mediaRoot } = input;
  if (!isAbsolute(engineArtifactRoot))
    throw new Error(
      'engineArtifactRoot must be an absolute path (deployment configuration, not per-attempt data)',
    );
  if (!isAbsolute(mediaRoot))
    throw new Error(
      'mediaRoot must be an absolute path (deployment configuration, not per-attempt data)',
    );

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
  const tempPath = join(
    tmpDirectory,
    `import-${attemptId}-${randomUUID()}.mp4.tmp`,
  );

  let cleanupTemp = true;
  try {
    let copy;
    try {
      copy = await streamCopyWithHash(enginePath, tempPath);
      await fsyncDirectory(dirname(tempPath));
    } catch {
      return refuse('io_error');
    }

    const probed = await probeVideo(tempPath).catch(
      (): ProbeCheck => ({ ok: false, reason: 'probe_failed' }),
    );
    if (!probed.ok) return refuse(probed.reason);

    const stored = await installAtContentAddress(
      tempPath,
      mediaRoot,
      copy.sha256,
    );
    cleanupTemp = false; // installAtContentAddress has already consumed or renamed the temp file
    return {
      ok: true,
      sha256: copy.sha256,
      byteSize: copy.byteSize,
      storageKey: stored.storageKey,
      probe: probed.probe,
    };
  } catch {
    return refuse('io_error');
  } finally {
    if (cleanupTemp) await rm(tempPath, { force: true });
  }
}
