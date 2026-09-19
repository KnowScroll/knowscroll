/** ADR-0023 section 4: verified local-host import boundary. This lane owns only the TYPE the
 * generation worker calls; the implementation (containment/probe/content-addressed write and the
 * `media_object`/`generated_reel` insert) belongs to the parallel import lane
 * (`apps/worker/src/generation/import.ts`, `tests/generation-import.test.ts`). Until that lane is
 * wired in, `main.ts` leaves a completed video job in `importing` and logs honestly rather than
 * fabricating an import result. */

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

export type ImportedVideo = {
  sha256: string;
  byteSize: number;
  storageKey: string;
  probe: unknown;
};

export interface ImportPort {
  importFinishedVideo(input: ImportFinishedVideoInput): Promise<ImportedVideo>;
}

/** A safe placeholder for this stage only: it always reports itself as not implemented rather
 * than performing any file I/O, so a job that reaches `importing` is never silently marked
 * complete without a real import lane wired in. Never used as the product's actual import path. */
export function createUnimplementedImportPort(): ImportPort {
  return {
    async importFinishedVideo() {
      throw new Error('import_port_not_implemented: the media import lane is not wired into this stage');
    },
  };
}
