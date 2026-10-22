import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import {
  apiContract,
  RecordingPolicyAcceptanceSchema,
  RecordingPolicyReadSchema,
  type RecordingProblem,
} from '@knowscroll/contracts';
import {
  RECORDING_POLICY_USE_CASES,
  type RecordingPolicyUseCases,
  type RecordingPolicyResult,
  type ScopeRefusal,
} from '@knowscroll/backend/modules/identity';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';
import { problem } from './problems.js';

const refusals: Record<Extract<RecordingPolicyResult<unknown>, { kind: 'refused' }>['code'], RecordingProblem['code']> =
  {
    invalid_input: 'INVALID_REQUEST',
    unavailable: 'UNIVERSE_UNAVAILABLE',
    command_key_reused: 'COMMAND_KEY_REUSED',
    stale_policy: 'RECORDING_POLICY_STALE',
    generation_exhausted: 'RECORDING_GENERATION_EXHAUSTED',
    revision_exhausted: 'SERVICE_UNAVAILABLE',
  };
function scopeCode(refusal: ScopeRefusal): RecordingProblem['code'] {
  switch (refusal.kind) {
    case 'account_mismatch':
      return 'FORBIDDEN';
    case 'epoch_changed':
      return 'PRIVACY_EPOCH_CHANGED';
    case 'universe_missing':
    case 'universe_suspended':
      return 'UNIVERSE_UNAVAILABLE';
  }
}

/** Historical command acknowledgement never replaces an independently read current policy. */
@Controller()
export class RecordingController {
  constructor(@Inject(RECORDING_POLICY_USE_CASES) private readonly recording: RecordingPolicyUseCases) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.recording.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.recording.read).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.recording.read(authorityOf(caller), input);
      if (result.kind === 'scope_refused') throw problem(scopeCode(result.refusal));
      if (result.kind === 'refused') throw problem(refusals[result.code]);
      const parsed = RecordingPolicyReadSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.readId !== input.readId ||
        parsed.data.scope.accountId !== caller.accountId ||
        parsed.data.scope.privacyEpoch !== caller.privacyEpoch ||
        parsed.data.target.kind !== input.target.kind ||
        (input.target.kind === 'command' &&
          (parsed.data.target.kind !== 'command' || parsed.data.target.commandId !== input.target.commandId))
      )
        throw problem('INTERNAL');
      return parsed.data;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.recording.set)
  setRoute(@Req() request: Request) {
    return implement(apiContract.recording.set).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.recording.set(authorityOf(caller), input);
      if (result.kind === 'scope_refused') throw problem(scopeCode(result.refusal));
      if (result.kind === 'refused') throw problem(refusals[result.code]);
      const parsed = RecordingPolicyAcceptanceSchema.safeParse(result.value);
      if (
        !parsed.success ||
        parsed.data.receipt.commandId !== input.commandId ||
        parsed.data.receipt.requestedPrivacyEpoch !== input.expectedPrivacyEpoch ||
        parsed.data.receipt.fromGeneration !== input.expectedRecordingGeneration ||
        parsed.data.receipt.on !== input.on ||
        (parsed.data.replayed
          ? parsed.data.receipt.requestedPrivacyEpoch > caller.privacyEpoch
          : parsed.data.receipt.requestedPrivacyEpoch !== caller.privacyEpoch)
      )
        throw problem('INTERNAL');
      return parsed.data;
    });
  }
}
