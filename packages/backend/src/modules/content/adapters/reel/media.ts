import { localMediaStore } from '../../../../infrastructure/media-store/index.js';
import type { InstallResult, ReelMedia } from '../../application/reel/ports.js';
import { CutroomReadRefusal, cutroomReadClient } from '../cutroom/read-client.js';
import { probeReel } from '../cutroom/probe.js';

const definitive = new Set(['media_profile_refused', 'media_faststart_refused']);

/** What went wrong with the file: never the path, never the system's own message. */
function classify(error: unknown): InstallResult {
  if (error instanceof CutroomReadRefusal)
    return error.code === 'artifact_size' || error.code === 'artifact_unsafe'
      ? { kind: 'refused', code: error.code }
      : { kind: 'unreadable', code: error.code };
  if (error instanceof Error && definitive.has(error.message)) return { kind: 'refused', code: error.message };
  // A media file ffprobe cannot read at all is not a Reel; any other failure (a missing file, a
  // permission, a missing ffprobe) is something an operator can fix, and the claim stays open.
  if (error instanceof Error && error.name === 'ZodError') return { kind: 'refused', code: 'media_profile_refused' };
  return { kind: 'unreadable', code: 'artifact_not_readable' };
}

/**
 * Copies the finished video out of Cutroom's artifact folder into this world's media store: the
 * path must be Cutroom's own render of that run inside the artifact root, the bytes are hashed while
 * they are copied, ffprobe must find the Reel profile (9:16, H.264 and AAC, 20 to 60 seconds,
 * streamable), and only then is the file installed under its content hash. No database is touched.
 */
export function makeReelMedia(settings: {
  readonly origin: string;
  readonly artifactRoot: string;
  readonly mediaRoot: string;
  readonly ffprobePath?: string | undefined;
}): ReelMedia {
  const artifacts = cutroomReadClient({ origin: settings.origin, artifactRoot: settings.artifactRoot });
  const store = localMediaStore(settings.mediaRoot);
  return {
    async install(video) {
      try {
        const file = await artifacts.openArtifact(video.path, video.runId);
        const staged = await store.stage(file.stream);
        try {
          if (staged.size !== file.size) return { kind: 'unreadable', code: 'artifact_changed' };
          const probe = await probeReel(staged.path, settings.ffprobePath);
          const media = await staged.commit();
          return { kind: 'installed', media: { key: media.key, sha256: media.sha256, size: media.size, probe } };
        } finally {
          await staged.discard();
        }
      } catch (error) {
        return classify(error);
      }
    },
  };
}
