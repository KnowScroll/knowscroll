import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ReceiveMedia, ReceiveMediaProof } from '../../production/commission-receive-ports.js';
import type { CommissionVerifiedMedia } from '../../production/commission-publication-ports.js';
import { receiveSha256 } from '../../production/commission-receive.js';
import { localMediaStore } from '../../../../infrastructure/media-store/index.js';
import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import { probeReel } from './probe.js';

/** Target-owned local staging only. No engine URL/opener/GET/pool/provider dependency. */
export function makeReceiveMedia(options: {
  readonly stagingRoot: string;
  readonly mediaRoot: string;
  readonly ffprobePath: string;
  readonly now?: () => number;
}): ReceiveMedia {
  const base = resolve(options.stagingRoot),
    store = localMediaStore(options.mediaRoot),
    now = options.now ?? Date.now;
  const proofs = new WeakMap<
    ReceiveMediaProof,
    { payloadSha256: string; generation: number; expires: number; media: CommissionVerifiedMedia }
  >();
  async function safeDirectory(path: string): Promise<void> {
    if (path !== base) await safeDirectory(dirname(path));
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (await realpath(path)) !== path)
      throw new Error('CUTROOM_RECEIVE_STAGING');
  }
  return {
    async prepare(payload, binding) {
      assertOutsideTransaction('cutroom.receive-media');
      let staged: Awaited<ReturnType<typeof store.stage>> | undefined;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const before = now();
        if (before < binding.observedAtMs || before >= binding.expiresAtMs) return;
        const dir = join(base, payload.handoffId),
          path = join(dir, `${payload.media.sha256}.mp4`);
        await safeDirectory(dir);
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size !== payload.media.sizeBytes ||
          stat.size <= 0 ||
          stat.size > 64 * 1024 * 1024 ||
          (stat.mode & 0o022) !== 0
        )
          return;
        staged = await store.stage(file.createReadStream({ autoClose: false }));
        const after = await file.stat();
        if (
          after.ino !== stat.ino ||
          after.dev !== stat.dev ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs ||
          staged.sha256 !== payload.media.sha256 ||
          staged.size !== payload.media.sizeBytes
        )
          return;
        const probe = await probeReel(staged.path, options.ffprobePath);
        if (
          probe.durationMs !== payload.document.durationMs ||
          probe.width !== payload.document.width ||
          probe.height !== payload.document.height ||
          now() < before ||
          now() >= binding.expiresAtMs
        )
          return;
        const media = await staged.commit();
        const proof = Object.freeze({}) as ReceiveMediaProof;
        proofs.set(proof, {
          payloadSha256: receiveSha256(JSON.stringify(payload)),
          generation: binding.generation,
          expires: Math.min(before + 30_000, binding.expiresAtMs),
          media: { key: media.key, sha256: media.sha256, size: media.size, probe },
        });
        return proof;
      } catch {
        return;
      } finally {
        await file?.close().catch(() => undefined);
        await staged?.discard().catch(() => undefined);
      }
    },
    consume(proof, payload, binding) {
      const value = proofs.get(proof);
      proofs.delete(proof);
      const time = now();
      if (
        !value ||
        value.payloadSha256 !== receiveSha256(JSON.stringify(payload)) ||
        value.generation !== binding.generation ||
        time < binding.observedAtMs ||
        time >= binding.expiresAtMs ||
        time >= value.expires
      )
        return;
      return value.media;
    },
  };
}
