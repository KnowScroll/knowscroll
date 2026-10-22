import type { RecordingChannelsResult } from './ports.js';
import type { JsonValue } from './ports.js';
import { ApplyActionResponseSchema, type ApplyActionRequest, type ProblemCode } from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { FindAssetForAction } from '../../content/public.js';
import type { Exposure } from '../domain/exposures.js';
type ReadExposureForEvidence = (scope: PersonalScopeTx, id: string) => Promise<Omit<Exposure, 'origin'> | undefined>;
import { recordingRequest, type CommandPorts } from './ports.js';
export interface ChannelState {
  readonly saved: boolean;
  readonly savedRevision?: number;
  readonly liked: boolean;
  readonly hidden: boolean;
  readonly savedOriginExposureId?: string;
  readonly likedOriginExposureId?: string;
  readonly savedOriginActionId?: string;
  readonly likedOriginActionId?: string;
}
export interface ChannelAction {
  readonly actionId: string;
  readonly commandId: string;
  readonly kind: ApplyActionRequest['kind'];
  readonly assetId: string;
  readonly assetRevision: number;
  readonly exposureId?: string;
  readonly at: Date;
  readonly recordingGeneration?: number;
  readonly operation?: string;
  readonly necessaryChanged?: boolean;
}
export interface EncounterActionPorts extends CommandPorts {
  readonly findAsset: FindAssetForAction;
  readonly readExposure: ReadExposureForEvidence;
  readonly readChannels: (scope: PersonalScopeTx, assetId: string) => Promise<ChannelState>;
  readonly commitAction: (
    scope: PersonalScopeTx,
    action: ChannelAction,
    before: ChannelState,
  ) => Promise<{ readonly changed: boolean; readonly recording?: RecordingChannelsResult }>;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (
    scope: PersonalScopeTx,
    change: { readonly revision: number; readonly eventId: string },
  ) => Promise<void>;
}
export function makeApplyEncounterAction(p: EncounterActionPorts) {
  return async (authority: PersonalAuthority, c: ApplyActionRequest) => {
    const operation = 'experience.encounter-action-v0';
    const request = {
      ...recordingRequest(c),
      kind: c.kind,
      target: c.target,
      ...(c.exposureId ? { exposureId: c.exposureId } : {}),
    };
    const key = {
      commandId: c.commandId,
      operation,
      requestHash: p.hashRequest(operation, request),
      outcomeVersion: 1,
    };
    const entered = await p.withPersonalScope(authority, async (scope) => {
      const lookup = await p.findReceipt(scope, key);
      if (lookup.kind === 'replay')
        return {
          kind: 'applied' as const,
          outcome: ApplyActionResponseSchema.parse({ ...(lookup.outcome as object), replayed: true }),
        };
      if (lookup.kind !== 'new')
        return {
          kind: 'refused' as const,
          code: (lookup.kind === 'outcome_version_newer' ? 'SERVICE_UNAVAILABLE' : 'COMMAND_KEY_REUSED') as ProblemCode,
        };
      const before = await p.readChannels(scope, c.target.assetId);
      const removal = c.kind === 'unsave' && before.saved && before.savedRevision === c.target.assetRevision;
      const asset = await p.findAsset(scope, c.target.assetId);
      if (!removal && (!asset || !asset.admitted))
        return { kind: 'refused' as const, code: 'ASSET_NOT_FOUND' as const };
      if (!removal && asset?.revision !== c.target.assetRevision)
        return { kind: 'refused' as const, code: 'ASSET_REVISION_STALE' as const };
      if (c.exposureId) {
        const x = await p.readExposure(scope, c.exposureId);
        if (
          !x?.activatedAt ||
          x.privacyEpoch !== scope.authority.privacyEpoch ||
          x.assetId !== c.target.assetId ||
          x.assetRevision !== c.target.assetRevision
        )
          return { kind: 'refused' as const, code: 'NOT_FOUND' as const };
      }
      const actionId = p.newId();
      await p.insertReceipt(scope, key);
      const effect = await p.commitAction(
        scope,
        {
          actionId,
          commandId: c.commandId,
          kind: c.kind,
          assetId: c.target.assetId,
          assetRevision: c.target.assetRevision,
          ...(c.exposureId ? { exposureId: c.exposureId } : {}),
          at: p.now(),
          operation,
          ...recordingRequest(c),
        },
        before,
      );
      const derived = effect.recording;
      const revision = derived?.changed
        ? derived.revision
        : effect.changed
          ? await p.advance(scope)
          : scope.revisionAtEntry;
      const saved = c.kind === 'save' ? true : c.kind === 'unsave' ? false : before.saved;
      const liked = c.kind === 'like' ? true : c.kind === 'unlike' ? false : before.liked;
      const hidden = c.kind === 'hide' ? true : before.hidden;
      const outcome = ApplyActionResponseSchema.parse({
        commandId: c.commandId,
        actionId,
        kind: c.kind,
        ...c.target,
        ...(c.kind === 'save' || c.kind === 'unsave' ? { saved } : { liked, hidden }),
        changed: effect.changed,
        revision,
        replayed: false,
      });
      await p.completeReceipt(scope, c.commandId, JSON.parse(JSON.stringify(outcome)) as Record<string, JsonValue>);
      if (effect.changed || effect.recording?.changed) await p.notify(scope, { revision, eventId: actionId });
      return { kind: 'applied' as const, outcome };
    });
    return entered.kind === 'entered'
      ? entered.value
      : {
          kind: 'refused' as const,
          code: (entered.refusal.kind === 'epoch_changed'
            ? 'PRIVACY_EPOCH_CHANGED'
            : 'UNIVERSE_UNAVAILABLE') as ProblemCode,
        };
  };
}
export type ApplyEncounterAction = ReturnType<typeof makeApplyEncounterAction>;
