import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { CutroomReceivingSettings } from '@knowscroll/backend/infrastructure/config';
import {
  CommissionReceiveSetupSchema,
  receiveCutroomQueue,
  recoverReceiveCutroomQueue,
  type CommissionReceive,
  type CommissionReceiveSetup,
} from '@knowscroll/backend/modules/content';
import { readRootCutroomPacket } from './cutroom-jobs.js';

/** Separate Root registry: no commissioning/pool settings, command arguments or timestamp renewal. */
export async function readReceiveSetup(
  settings: CutroomReceivingSettings,
  world: string,
): Promise<CommissionReceiveSetup> {
  const parsed = CommissionReceiveSetupSchema.safeParse(await readRootCutroomPacket(settings));
  if (!parsed.success || parsed.data.worldId !== world) throw new Error('CUTROOM_RECEIVING_SETUP_UNAVAILABLE');
  return parsed.data;
}
export function receiveConsumers(
  settings: CutroomReceivingSettings | undefined,
  world: string,
  assemble: (setup: CommissionReceiveSetup) => CommissionReceive,
): readonly JobConsumer<unknown>[] {
  async function run(method: 'receive' | 'recover', input: unknown) {
    if (settings?.enabled !== true) return;
    const setup = await readReceiveSetup(settings, world);
    await assemble(setup)[method](input);
  }
  return [
    jobConsumer(receiveCutroomQueue, (p) => run('receive', p)),
    jobConsumer(recoverReceiveCutroomQueue, (p) => run('recover', p)),
  ];
}
