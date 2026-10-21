import { z } from 'zod';
import {
  prepareCutroomCommission,
  CutroomCommissionScriptSchema,
  CutroomApprovalReferenceSchema,
} from './commission-contracts.js';
import type { CutroomBResult, CutroomCandidate } from '../../../reasoning/public.js';
import type { CommissionPorts } from './commission-ports.js';
const inputSchema = z.strictObject({
  businessRunId: z.uuid(),
  authority: z.strictObject({
    worldId: z.enum(['dev', 'stage']),
    generation: z.number().int().positive().max(2147483647),
  }),
  script: CutroomCommissionScriptSchema,
  approvalReference: CutroomApprovalReferenceSchema,
  take: z.number().int().min(1).max(999),
  ceilingCents: z.number().int().min(1).max(75),
  principalOid: z.string().regex(/^[1-9][0-9]{0,9}$/),
  principalName: z.string().min(1).max(63),
  grantRef: z.literal('knowscroll-v2-d018'),
});
class Stop extends Error {
  constructor(readonly result: CutroomBResult) {
    super('COMMISSION_ROLLBACK');
  }
}
/** No public constructor mints approval. New work requires Reasoning's empty-by-default trusted registry. */
export function makeCommission(p: CommissionPorts) {
  return async (input: unknown): Promise<CutroomBResult> => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { kind: 'refused', code: 'invalid' };
    const command = parsed.data,
      commandSha = p.sha256(JSON.stringify(command));
    try {
      const result = await p.reasoning.withScope(command.authority, 'admit', async (scope) => {
        // Existing immutable business is checked before compilation. Expired bytes are NEVER regenerated.
        const old = await p.store.lock(scope, command.businessRunId);
        if (old) {
          if (old.commandSha256 !== commandSha || old.attemptId === null)
            return { kind: 'held', code: 'identity' } as const;
          return p.reasoning.readScoped(scope, old.attemptId);
        }
        const prepared = prepareCutroomCommission(command.script, command.approvalReference, {
          take: command.take,
          worldId: command.authority.worldId,
          ceilingCents: command.ceilingCents,
        });
        if (prepared.kind !== 'prepared') return { kind: 'refused', code: 'invalid' } as const;
        const candidate: CutroomCandidate = {
          businessRunId: command.businessRunId,
          generation: command.authority.generation,
          worldId: command.authority.worldId,
          policyVersion: prepared.policyVersion,
          scriptSha256: prepared.scriptSha256,
          evidenceSha256: prepared.evidenceSha256,
          requestId: prepared.requestId,
          requestSha256: prepared.requestSha256,
          requestUtf8: prepared.requestUtf8,
          byteLength: prepared.byteLength,
          contractVersion: 1,
          take: command.take,
          until: 'video',
          ceilingCents: command.ceilingCents,
          approvalRef: prepared.approvalRef,
          grantRef: command.grantRef,
          principalOid: command.principalOid,
          principalName: command.principalName,
        };
        if (!p.reasoning.admitted(scope, candidate)) return { kind: 'refused', code: 'authority' } as const;
        if (!(await p.store.insert(scope, candidate, commandSha, JSON.stringify(command.script))))
          return { kind: 'held', code: 'identity' } as const;
        const reserved = await p.reasoning.reserve(scope, candidate);
        if (reserved.kind !== 'pending') throw new Stop(reserved);
        await p.store.bind(scope, command.businessRunId, reserved.attemptId);
        return reserved;
      });
      return result.kind === 'entered' ? result.value : { kind: 'refused', code: result.code };
    } catch (error) {
      if (error instanceof Stop) return error.result;
      throw error;
    }
  };
}
