import { makeCheckScript } from './check-script.js';
import { makeFollowReel } from './follow.js';
import { makeOrderReel } from './order.js';
import type { ReelPorts } from './ports.js';
import { makeReceiveReel } from './receive.js';
import { makeSettleUnpublished } from './settle-unpublished.js';
import { makeReelStatus } from './status.js';
import { makeWriteOff } from './write-off.js';

/**
 * The commands an operator runs to bring a Reel from an approved script into a world. One order is
 * one script at one stage: `plan` (a free rehearsal) or `video` (the paid Reel). Each command is
 * safe to repeat; none keeps a lock, a transaction or a promise open across a Cutroom or pool call.
 */
export function makeReelOperator(ports: ReelPorts) {
  return {
    check: makeCheckScript(ports),
    order: makeOrderReel(ports),
    follow: makeFollowReel(ports),
    receive: makeReceiveReel(ports),
    status: makeReelStatus(ports),
    writeOff: makeWriteOff(ports),
    settleUnpublished: makeSettleUnpublished(ports),
  };
}

export type ReelOperator = ReturnType<typeof makeReelOperator>;
