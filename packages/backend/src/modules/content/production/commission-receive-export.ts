import { z } from 'zod';
import { CommissionReceivePayloadSchema } from './commission-receive-contracts.js';
import { parseReceiveEnvelope, receiveSha256 } from './commission-receive.js';
import type { CommissionReceiveOrigin, ReceiveEnvelope } from './commission-receive-ports.js';
/** Pure bounded origin snapshot export. It cannot settle, collect, transfer or authorize admission. */
export function makeCommissionReceiveExport(origin: CommissionReceiveOrigin) {
  const query = z.strictObject({ publicationId: z.uuid(), targetWorld: z.enum(['dev', 'stage']) });
  return async (input: unknown): Promise<ReceiveEnvelope | undefined> => {
    const q = query.safeParse(input);
    if (!q.success) return;
    const result = await origin.read(q.data.publicationId, q.data.targetWorld);
    const parsed = CommissionReceivePayloadSchema.safeParse(result);
    if (!parsed.success) return;
    const envelope = {
      payloadUtf8: JSON.stringify(parsed.data),
      payloadSha256: receiveSha256(JSON.stringify(parsed.data)),
    };
    return parseReceiveEnvelope(envelope) ? envelope : undefined;
  };
}
