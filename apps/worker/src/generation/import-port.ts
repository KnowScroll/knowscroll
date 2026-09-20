/** ADR-0023 section 4, issue #94 stage A2: the generation worker's verified-import boundary.
 * `./import.ts` owns the real filesystem/database implementation (containment, hashing, probe,
 * content-addressed write, the `media_object`/`generated_reel` insert); this file owns only the
 * narrow port `worker.ts` calls through, plus the factory that fixes `mediaRoot` (KS_MEDIA_ROOT —
 * KnowScroll's own deployment configuration, never per-attempt data) at construction. A completed
 * `ImportOutcome` is never thrown: `{ok:false, reason}` is a well-typed, expected refusal the
 * worker records honestly. A THROWN error from a port instead means the port itself is missing or
 * broken (a wiring defect, not a data refusal) — see `createUnimplementedImportPort` below. */
import {importFinishedVideo, type ImportFinishedVideoInput as RealImportInput, type ImportOutcome} from './import.ts';

export type {ImportOutcome} from './import.ts';

export type ImportFinishedVideoInput = {
  /** The `cutroom_attempt.id` the finished result belongs to. */
  attemptId: string;
  /** The Cutroom run id the video was produced by. */
  runId: string;
  /** The untrusted absolute path Cutroom's result reported, before containment is checked. */
  enginePath: string;
  /** The engine's registered artifact root; the imported path must resolve strictly inside it. */
  engineArtifactRoot: string;
};

export interface ImportPort {
  importFinishedVideo(input: ImportFinishedVideoInput): Promise<ImportOutcome>;
}

/** The real import port. `mediaRoot` is fixed once at construction (`main.ts` reads
 * `KS_MEDIA_ROOT`), matching `import.ts`'s own contract that it is deployment configuration and
 * never a per-attempt value a caller could vary. */
export function createLocalImportPort(mediaRoot: string): ImportPort {
  return {
    async importFinishedVideo(input: ImportFinishedVideoInput): Promise<ImportOutcome> {
      const full: RealImportInput = {...input, mediaRoot};
      return importFinishedVideo(full);
    },
  };
}

/** A safe placeholder for callers that wire no import port at all: it always THROWS rather than
 * performing any file I/O or returning a fabricated outcome, so a job that reaches `importing`
 * without a real port configured is left honestly unfinished (`worker.ts` logs `import_not_available`
 * and takes no further action) instead of ever being marked complete or refused. Never used by
 * `main.ts`'s real process, which always constructs `createLocalImportPort`. */
export function createUnimplementedImportPort(): ImportPort {
  return {
    async importFinishedVideo(): Promise<ImportOutcome> {
      throw new Error('import_port_not_implemented: the media import lane is not wired into this stage');
    },
  };
}
