import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { CutroomCommissioningSettings } from '@knowscroll/backend/infrastructure/config';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import {
  cutroomPoolQueue,
  cutroomFollowQueue,
  cutroomAccountingQueue,
  cutroomSettleQueue,
  recoverCutroomQueue,
} from '@knowscroll/backend/reasoning';
import {
  parseCommissioningSetup,
  type Commissioning,
  type CommissioningSetup,
} from '@knowscroll/backend/modules/content';
export interface ConnectedCutroom {
  readonly useCase: Commissioning;
  close(): Promise<void>;
}
export type AssembleCutroom = (setup: CommissioningSetup) => ConnectedCutroom;
/** Sole-writer/operator-owned input, never HTTP input or an inferred approval. No timestamp
 * is refreshed. Bounded file contents/errors are never emitted to logs or job results. */
export async function readCutroomSetup(
  settings: CutroomCommissioningSettings,
  world: string,
): Promise<CommissioningSetup> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = settings.packetPath;
    if (!settings.enabled || !path || !path.startsWith('/etc/knowscroll/') || (await realpath(path)) !== path)
      throw new Error('CUTROOM_SETUP_UNAVAILABLE');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      (before.mode & 0o022) !== 0 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 1048576
    )
      throw new Error('CUTROOM_SETUP_UNAVAILABLE');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const r = await file.read(bytes, used, bytes.length - used, used);
      if (r.bytesRead === 0) break;
      used += r.bytesRead;
    }
    const after = await file.stat();
    if (
      used !== before.size ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('CUTROOM_SETUP_UNAVAILABLE');
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    const pending = [{ value: raw, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (++nodes > 50000 || item.depth > 24) throw new Error('CUTROOM_SETUP_UNAVAILABLE');
      if (item.value !== null && typeof item.value === 'object') {
        const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
        if (nodes + children.length + pending.length > 50000) throw new Error('CUTROOM_SETUP_UNAVAILABLE');
        for (const value of children) pending.push({ value, depth: item.depth + 1 });
      }
    }
    const setup = parseCommissioningSetup(raw);
    if (!setup || setup.worldId !== world) throw new Error('CUTROOM_SETUP_UNAVAILABLE');
    return setup;
  } catch {
    throw new Error('CUTROOM_SETUP_UNAVAILABLE');
  } finally {
    await file?.close();
  }
}
/** Every normal delivery re-reads actual externally refreshed attestations. An absent setup
 * cannot dispatch, and a restart retains all work in pg-boss plus existing exact receipts. */
export function cutroomConsumers(
  settings: CutroomCommissioningSettings,
  world: string,
  assemble: AssembleCutroom,
): readonly JobConsumer<unknown>[] {
  const run = async (method: 'pool' | 'follow' | 'accounting' | 'settle' | 'recover', payload: unknown) => {
    if (!settings.enabled) return;
    const setup = await readCutroomSetup(settings, world),
      connected = assemble(setup);
    try {
      await connected.useCase[method](payload);
    } finally {
      await connected.close();
    }
  };
  return [
    jobConsumer(cutroomPoolQueue, (p) => run('pool', p)),
    jobConsumer(cutroomFollowQueue, (p) => run('follow', p)),
    jobConsumer(cutroomAccountingQueue, (p) => run('accounting', p)),
    jobConsumer(cutroomSettleQueue, (p) => run('settle', p)),
    jobConsumer(recoverCutroomQueue, (p) => run('recover', p)),
  ];
}
