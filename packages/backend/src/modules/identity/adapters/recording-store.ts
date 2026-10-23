import { RecordingPolicySchema, SetRecordingPolicySchema, RecordingPolicyReceiptSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { RecordingStore } from '../application/recording-ports.js';
/** Every query uses the genuine, already-locked personal transaction. No independent transaction. */
export const recordingStore: RecordingStore = {
  async current(scope) {
    const r = await transactionOf(scope)
      .selectFrom('identity.universes as u')
      .innerJoin('identity.accounts as a', 'a.id', 'u.account_id')
      .select(['u.account_id', 'u.revision', 'u.recording_on', 'u.recording_generation'])
      .where('u.id', '=', scope.authority.universeId)
      .where('u.privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('u.status', '=', 'active')
      .where('a.status', '=', 'active')
      .where('u.clear_operation_id', 'is', null)
      .executeTakeFirst();
    return r
      ? {
          accountId: r.account_id,
          revision: r.revision,
          policy: RecordingPolicySchema.parse({ on: r.recording_on, generation: r.recording_generation }),
        }
      : undefined;
  },
  async command(scope, accountId, commandId) {
    const r = await transactionOf(scope)
      .selectFrom('identity.recording_commands')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('command_id', '=', commandId)
      .executeTakeFirst();
    if (!r) return undefined;
    const body = SetRecordingPolicySchema.parse(r.request_body);
    return {
      universeId: r.scope_id,
      requestHash: r.request_hash,
      body,
      outcomeVersion: 1,
      receipt: RecordingPolicyReceiptSchema.parse({
        commandId: body.commandId,
        requestedPrivacyEpoch: r.requested_epoch,
        on: r.requested_on,
        fromGeneration: r.from_generation,
        toGeneration: r.to_generation,
        changed: r.changed,
        recordedAt: new Date(r.recorded_at).toISOString(),
      }),
    };
  },
  async accept(scope, snapshot, command) {
    const trx = transactionOf(scope),
      r = command.receipt;
    const changed = await trx
      .updateTable('identity.universes')
      .set({ recording_on: r.on, recording_generation: r.toGeneration, revision: snapshot.revision + 1 })
      .where('id', '=', scope.authority.universeId)
      .where('account_id', '=', snapshot.accountId)
      .where('privacy_epoch', '=', scope.authority.privacyEpoch)
      .where('clear_operation_id', 'is', null)
      .where('recording_generation', '=', r.fromGeneration)
      .where('recording_on', '=', snapshot.policy.on)
      .where('revision', '=', snapshot.revision)
      .returning('id')
      .executeTakeFirst();
    if (!changed) throw new Error('RECORDING_POLICY_CAS');
    await trx
      .insertInto('identity.recording_commands')
      .values({
        account_id: snapshot.accountId,
        scope_id: scope.authority.universeId,
        command_id: command.body.commandId,
        request_hash: command.requestHash,
        request_body: command.body,
        outcome_version: command.outcomeVersion,
        requested_epoch: r.requestedPrivacyEpoch,
        requested_on: r.on,
        from_generation: r.fromGeneration,
        to_generation: r.toGeneration,
        changed: r.changed,
        recorded_at: new Date(r.recordedAt),
      })
      .execute();
  },
};
