import {
  SetRecordingPolicySchema,
  ReadRecordingPolicySchema,
  RecordingPolicyAcceptanceSchema,
  RecordingPolicyReadSchema,
  RecordingPolicyReceiptSchema,
} from '@knowscroll/contracts';
import type { RecordingPolicyUseCases } from '../public.js';
import type { RecordingPorts } from './recording-ports.js';
const MAX = 2_147_483_647;
/** Current authority precedes historical receipt recovery. An ACK is never current policy. */
export function makeRecordingPolicy(p: RecordingPorts): RecordingPolicyUseCases {
  return {
    async set(authority, input) {
      const parsed = SetRecordingPolicySchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'invalid_input' };
      const q = parsed.data;
      const entered = await p.withScope(authority, async (scope) => {
        if (scope.authority.actor.kind !== 'account') return { kind: 'refused', code: 'unavailable' } as const;
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return { kind: 'refused', code: 'unavailable' } as const;
        const current = await p.store.current(scope);
        if (!current || current.accountId !== gate.owner.accountId)
          return { kind: 'refused', code: 'unavailable' } as const;
        const hash = p.hash(q);
        const old = await p.store.command(scope, current.accountId, q.commandId);
        if (old) {
          if (old.universeId !== scope.authority.universeId || old.outcomeVersion !== 1)
            return { kind: 'refused', code: 'unavailable' } as const;
          if (old.requestHash !== hash || p.hash(old.body) !== hash)
            return { kind: 'refused', code: 'command_key_reused' } as const;
          return {
            kind: 'ok',
            value: RecordingPolicyAcceptanceSchema.parse({
              version: 'recording-policy.v1',
              operation: 'privacy.recording-set',
              outcome: 'accepted',
              receipt: old.receipt,
              replayed: true,
            }),
          } as const;
        }
        if (
          q.expectedPrivacyEpoch !== scope.authority.privacyEpoch ||
          q.expectedRecordingGeneration !== current.policy.generation
        )
          return { kind: 'refused', code: 'stale_policy' } as const;
        const changed = q.on !== current.policy.on;
        if (changed && current.policy.generation === MAX)
          return { kind: 'refused', code: 'generation_exhausted' } as const;
        if (current.revision >= MAX) return { kind: 'refused', code: 'revision_exhausted' } as const;
        const receipt = RecordingPolicyReceiptSchema.parse({
          commandId: q.commandId,
          requestedPrivacyEpoch: q.expectedPrivacyEpoch,
          on: q.on,
          fromGeneration: current.policy.generation,
          toGeneration: current.policy.generation + (changed ? 1 : 0),
          changed,
          recordedAt: p.now().toISOString(),
        });
        await p.store.accept(scope, current, {
          universeId: scope.authority.universeId,
          requestHash: hash,
          body: q,
          outcomeVersion: 1,
          receipt,
        });
        return {
          kind: 'ok',
          value: RecordingPolicyAcceptanceSchema.parse({
            version: 'recording-policy.v1',
            operation: 'privacy.recording-set',
            outcome: 'accepted',
            receipt,
            replayed: false,
          }),
        } as const;
      });
      return entered.kind === 'entered' ? entered.value : { kind: 'scope_refused', refusal: entered.refusal };
    },
    async read(authority, input) {
      const parsed = ReadRecordingPolicySchema.safeParse(input);
      if (!parsed.success) return { kind: 'refused', code: 'invalid_input' };
      const q = parsed.data;
      const entered = await p.withScope(authority, async (scope) => {
        if (scope.authority.actor.kind !== 'account') return { kind: 'refused', code: 'unavailable' } as const;
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return { kind: 'refused', code: 'unavailable' } as const;
        const current = await p.store.current(scope);
        if (!current || current.accountId !== gate.owner.accountId)
          return { kind: 'refused', code: 'unavailable' } as const;
        const old =
          q.target.kind === 'command' ? await p.store.command(scope, current.accountId, q.target.commandId) : undefined;
        if (old && (old.universeId !== scope.authority.universeId || old.outcomeVersion !== 1))
          return { kind: 'refused', code: 'unavailable' } as const;
        return {
          kind: 'ok',
          value: RecordingPolicyReadSchema.parse({
            version: 'recording-policy.v1',
            readId: q.readId,
            scope: { accountId: current.accountId, privacyEpoch: scope.authority.privacyEpoch },
            revision: current.revision,
            policy: current.policy,
            target: q.target,
            ...(q.target.kind === 'command'
              ? old
                ? { status: 'recorded', receipt: old.receipt }
                : { status: 'not_recorded' }
              : {}),
          }),
        } as const;
      });
      return entered.kind === 'entered' ? entered.value : { kind: 'scope_refused', refusal: entered.refusal };
    },
  };
}
