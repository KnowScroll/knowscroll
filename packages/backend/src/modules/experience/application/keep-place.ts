import {
  ReadKeepEntrySchema,
  KeepEntrySnapshotSchema,
  SetKeepPlaceSchema,
  KeepPlaceAcceptanceSchema,
  type KeepEntryRef,
  type KeepEntrySnapshot,
  type KeepPlaceAcceptance,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx, ScopeOutcome } from '../../identity/public.js';
import { KEEP_ROOT_MAX_REVISION, nextKeepRevision, positionForTarget } from '../domain/keep-place.js';
import { keepRefuse, type KeepPorts, type KeepResult } from './keep-ports.js';
export const KEEP_PLACE_OPERATION = 'experience.keep-place-set';
export const KEEP_PLACE_OUTCOME_VERSION = 1;
const sameEntry = (a: KeepEntryRef, b: KeepEntryRef) =>
  a.assetId.toLowerCase() === b.assetId.toLowerCase() &&
  a.savedEntryId.toLowerCase() === b.savedEntryId.toLowerCase() &&
  a.assetRevision === b.assetRevision;
function envelope(scope: PersonalScopeTx) {
  if (scope.authority.actor.kind !== 'account') throw new Error('KEEP_ACCOUNT_REQUIRED');
  return {
    version: 'keep-place.v1' as const,
    scope: { accountId: scope.authority.actor.accountId, privacyEpoch: scope.authority.privacyEpoch },
  };
}
function entered<T>(result: ScopeOutcome<KeepResult<T>>): KeepResult<T> {
  return result.kind === 'entered'
    ? result.value
    : keepRefuse(result.refusal.kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
}
export function makeReadKeepEntry(p: KeepPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<KeepResult<KeepEntrySnapshot>> => {
    const parsed = ReadKeepEntrySchema.safeParse(input);
    if (!parsed.success) return keepRefuse('INVALID_REQUEST');
    const read = parsed.data;
    return entered(
      await p.withScope(authority, async (scope): Promise<KeepResult<KeepEntrySnapshot>> => {
        if (scope.authority.actor.kind !== 'account') return keepRefuse('UNIVERSE_UNAVAILABLE');
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return keepRefuse('UNIVERSE_UNAVAILABLE');
        const membership = await p.store.membership(scope, read.target.assetId);
        const common = { ...envelope(scope), target: read.target };
        if (!membership || membership.assetRevision !== read.target.assetRevision)
          return { kind: 'ok', value: KeepEntrySnapshotSchema.parse({ ...common, status: 'not_saved' }) };
        // Echo the exact requested UUID spelling; membership equality is PostgreSQL UUID identity.
        const entry = { ...membership, assetId: read.target.assetId };
        const target = await p.target(scope, gate.owner, read.target);
        if (!target)
          return {
            kind: 'ok',
            value: KeepEntrySnapshotSchema.parse({ ...common, status: 'saved_unavailable', entry }),
          };
        const place = await p.store.place(scope, entry.savedEntryId);
        if (place && JSON.stringify(positionForTarget(place.position, target)) !== JSON.stringify(place.position))
          return keepRefuse('SERVICE_UNAVAILABLE');
        return {
          kind: 'ok',
          value: KeepEntrySnapshotSchema.parse({
            ...common,
            status: 'available',
            entry,
            place: place
              ? { status: 'set', placeRevision: place.revision, position: place.position }
              : { status: 'none', placeRevision: 0 },
          }),
        };
      }),
    );
  };
}
export function makeSetKeepPlace(p: KeepPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<KeepResult<KeepPlaceAcceptance>> => {
    const parsed = SetKeepPlaceSchema.safeParse(input);
    if (!parsed.success) return keepRefuse('INVALID_REQUEST');
    const command = parsed.data;
    const key = {
      commandId: command.commandId,
      operation: KEEP_PLACE_OPERATION,
      requestHash: p.hash(KEEP_PLACE_OPERATION, command),
      outcomeVersion: KEEP_PLACE_OUTCOME_VERSION,
    };
    return entered(
      await p.withScope(authority, async (scope): Promise<KeepResult<KeepPlaceAcceptance>> => {
        if (scope.authority.actor.kind !== 'account') return keepRefuse('UNIVERSE_UNAVAILABLE');
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return keepRefuse('UNIVERSE_UNAVAILABLE');
        const membership = await p.store.membership(scope, command.entry.assetId);
        if (!membership || !sameEntry(membership, command.entry)) return keepRefuse('KEEP_ENTRY_UNAVAILABLE');
        const target = await p.target(scope, gate.owner, {
          assetId: command.entry.assetId,
          assetRevision: command.entry.assetRevision,
        });
        if (!target) return keepRefuse('KEEP_ENTRY_UNAVAILABLE');
        const current = await p.store.place(scope, membership.savedEntryId);
        if (current && JSON.stringify(positionForTarget(current.position, target)) !== JSON.stringify(current.position))
          return keepRefuse('SERVICE_UNAVAILABLE');
        const lookup = await p.store.findReceipt(scope, key);
        if (lookup.kind === 'replay') {
          const stored = KeepPlaceAcceptanceSchema.safeParse(lookup.outcome);
          if (
            !stored.success ||
            stored.data.replayed ||
            stored.data.commandId !== command.commandId ||
            stored.data.scope.accountId !== gate.owner.accountId ||
            stored.data.scope.privacyEpoch !== gate.owner.privacyEpoch ||
            !sameEntry(stored.data.entry, command.entry) ||
            stored.data.basePlaceRevision !== command.expectedPlaceRevision ||
            !current ||
            current.revision < stored.data.acceptedPlaceRevision
          )
            return keepRefuse('SERVICE_UNAVAILABLE');
          return { kind: 'ok', value: { ...stored.data, replayed: true } };
        }
        if (lookup.kind === 'outcome_version_newer') return keepRefuse('SERVICE_UNAVAILABLE');
        if (lookup.kind !== 'new') return keepRefuse('COMMAND_KEY_REUSED');
        const position = positionForTarget(command.position, target);
        if (!position) return keepRefuse('UNPROCESSABLE_REQUEST');
        const base = current?.revision ?? 0;
        if (base !== command.expectedPlaceRevision)
          return { kind: 'refused', code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: base };
        const revision = nextKeepRevision(base);
        if (revision === undefined) return keepRefuse('KEEP_PLACE_COUNTER_EXHAUSTED');
        if (scope.revisionAtEntry >= KEEP_ROOT_MAX_REVISION) return keepRefuse('SERVICE_UNAVAILABLE');
        const value = KeepPlaceAcceptanceSchema.parse({
          ...envelope(scope),
          commandId: command.commandId,
          recordedAt: p.now().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'keep.place.set',
          entry: command.entry,
          basePlaceRevision: base,
          acceptedPlaceRevision: revision,
        });
        await p.store.beginReceipt(scope, key);
        await p.store.write(scope, membership.savedEntryId, base, position);
        await p.store.completeReceipt(scope, command.commandId, value);
        const watermark = await p.advance(scope);
        await p.notify(scope, { revision: watermark, eventId: command.commandId });
        return { kind: 'ok', value };
      }),
    );
  };
}
