import {
  OwnPresencePreferenceSchema,
  PresencePreferenceAcceptanceSchema,
  SetPresencePreferenceSchema,
  SetSharingVisibilitySchema,
  SharingVisibilityAcceptanceSchema,
  SharingVisibilitySchema,
  isPublicLabel,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { increment } from '../domain/friends.js';
import { planPublication, publicationChanged, shareableSystems } from '../domain/visibility.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';
import type { ChosenFriend, StoredPublication } from './visibility-store.js';
import { readOwnPlaces, type VisibilityPorts } from './visibility-ports.js';

type ReadVisibility = z.infer<typeof SharingVisibilitySchema>;
type VisibilityAcceptance = z.infer<typeof SharingVisibilityAcceptanceSchema>;
type ReadPreference = z.infer<typeof OwnPresencePreferenceSchema>;
type PreferenceAcceptance = z.infer<typeof PresencePreferenceAcceptanceSchema>;

const lower = (ids: readonly string[]): string[] => [...new Set(ids.map((id) => id.toLowerCase()))];
const sameMembers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

function receiptKey(p: SocialPorts, operation: string, command: { readonly commandId: string }) {
  return { commandId: command.commandId, operation, outcomeVersion: 1, requestHash: p.hash(operation, command) };
}

/** What the owner's own settings page shows as the audience; a chosen list with no one left is "nobody". */
function audienceView(mode: string, chosen: readonly ChosenFriend[]): ReadVisibility['audience'] {
  if (mode === 'all_friends') return { mode: 'all_friends' };
  if (mode === 'chosen_friends' && chosen.length > 0)
    return { mode: 'chosen_friends', personIds: chosen.map((friend) => friend.personId) };
  return { mode: 'nobody' };
}

/**
 * The caller's own visitor settings: who may visit, and each of their systems with whether it is
 * shared. Reading writes nothing and creates no evidence. Own authority only (the owner's account
 * fence), so no one else can read it. Not readable Geography refuses rather than showing no systems.
 */
export function makeReadVisibility(p: VisibilityPorts) {
  return async (authority: PersonalAuthority): Promise<Result<ReadVisibility>> => {
    const result = await p.withScope(authority, async (scope): Promise<Result<ReadVisibility>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const own = await readOwnPlaces(p, scope);
      if (!own) return refuse('unavailable');
      const stored = await p.visibility.settings(scope, gate.owner.accountId);
      const chosen = await p.visibility.chosenFriends(scope, gate.owner.accountId);
      const published = await p.visibility.publication(scope, gate.owner.universeId);
      const sharedIds = new Set(published?.systems.map((system) => system.systemId));
      return {
        kind: 'ok',
        value: SharingVisibilitySchema.parse({
          ...ownEnvelope(scope),
          visibilityRevision: stored.visibilityRevision,
          audience: audienceView(stored.audience, chosen),
          systems: shareableSystems(own.places, isPublicLabel).map((system) => ({
            ...system,
            shared: sharedIds.has(system.systemId),
          })),
        }),
      };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}

/**
 * Sets who may visit and which systems they see, in one command.
 *
 * Authority: the caller's own account, under their personal root. Chosen friends must be friends now
 * and every system must be one of the caller's own factual systems, or the command is refused with
 * nothing changed. The new published copy is drawn in the same transaction from the caller's own
 * Geography, so a revocation is in force for the very next visitor read. Effects: settings row,
 * chosen-friend rows, published systems and planets, and the command receipt. No model call, no
 * queue work, no evidence, and nothing is told to the people whose access changed.
 * Retry: the same command ID with the same body replays the first answer; a stale expected revision
 * is `stale_revision` and the client rereads.
 */
export function makeSetVisibility(p: VisibilityPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<Result<VisibilityAcceptance>> => {
    const parsed = SetSharingVisibilitySchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const result = await p.withScope(authority, async (scope): Promise<Result<VisibilityAcceptance>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const accountId = gate.owner.accountId;
      const key = receiptKey(p, 'social.visibility-set', command);
      const receipt = await p.store.findReceipt(scope, key);
      if (receipt.kind === 'refused') return receipt;
      if (receipt.kind === 'replay')
        return {
          kind: 'ok',
          value: SharingVisibilityAcceptanceSchema.parse({
            ...SharingVisibilityAcceptanceSchema.parse(receipt.outcome),
            replayed: true,
          }),
        };
      const stored = await p.visibility.settings(scope, accountId);
      if (stored.visibilityRevision !== command.expectedVisibilityRevision) return refuse('stale_revision');
      const own = await readOwnPlaces(p, scope);
      if (!own) return refuse('unavailable');

      const chosenSystems = new Set(lower(command.sharedSystemIds));
      const offered = new Set(shareableSystems(own.places, isPublicLabel).map((system) => system.systemId));
      if (![...chosenSystems].every((systemId) => offered.has(systemId))) return refuse('invalid_input');
      let friendAccountIds: string[] = [];
      if (command.audience.mode === 'chosen_friends') {
        const wanted = lower(command.audience.personIds);
        const friends = await p.visibility.currentFriends(scope, accountId, wanted);
        if (friends.length !== wanted.length) return refuse('invalid_input');
        friendAccountIds = friends.map((friend) => friend.accountId);
      }

      const before = await p.visibility.publication(scope, gate.owner.universeId);
      const planned = planPublication(own.places, chosenSystems, before?.systems ?? [], isPublicLabel, () =>
        p.newPublicId(),
      );
      const chosenBefore = (await p.visibility.chosenFriends(scope, accountId)).map((friend) => friend.accountId);
      const systemsChanged = publicationChanged(before?.systems ?? [], planned);
      const audienceChanged = stored.audience !== command.audience.mode || !sameMembers(chosenBefore, friendAccountIds);
      const changed = systemsChanged || audienceChanged;
      const visibilityRevision = changed ? increment(stored.visibilityRevision) : stored.visibilityRevision;

      await p.store.beginReceipt(scope, key);
      if (changed) {
        await p.visibility.saveSettings(scope, accountId, {
          ...stored,
          audience: command.audience.mode,
          visibilityRevision,
        });
        await p.visibility.replaceChosenFriends(scope, accountId, friendAccountIds);
        await p.visibility.savePublication(scope, gate.owner.universeId, {
          ...nextPublication(before, planned, own.geographyRevision, systemsChanged, () => p.newOpaqueToken()),
          refreshedAt: p.now(),
        });
      }
      const value = SharingVisibilityAcceptanceSchema.parse({
        ...ownEnvelope(scope),
        commandId: command.commandId,
        recordedAt: p.now().toISOString(),
        replayed: false,
        outcome: 'accepted',
        operation: 'visibility.set',
        baseVisibilityRevision: stored.visibilityRevision,
        acceptedVisibilityRevision: visibilityRevision,
      });
      await p.store.receipt(scope, key, value);
      return { kind: 'ok', value };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}

/**
 * The published copy after a change. Its token is new for the first copy and whenever visitors would
 * see a difference, and unchanged otherwise. It is random, so a visitor can tell that the list moved
 * but not how often it has.
 */
export function nextPublication(
  before: StoredPublication | undefined,
  systems: StoredPublication['systems'],
  geographyRevision: number,
  changed: boolean,
  newToken: () => number,
): StoredPublication {
  return {
    systems,
    geographyRevision,
    projectionToken: before === undefined || changed ? newToken() : before.projectionToken,
  };
}

/** The caller's own availability choice. Reading writes nothing. */
export function makeReadPresencePreference(p: VisibilityPorts) {
  return async (authority: PersonalAuthority): Promise<Result<ReadPreference>> => {
    const result = await p.withScope(authority, async (scope): Promise<Result<ReadPreference>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const stored = await p.visibility.settings(scope, gate.owner.accountId);
      return {
        kind: 'ok',
        value: OwnPresencePreferenceSchema.parse({
          ...ownEnvelope(scope),
          presencePreferenceRevision: stored.presenceRevision,
          preference: stored.presencePreference,
        }),
      };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}

/**
 * Chooses whether friends may see "Online", "Recently active" or nothing. Hiding deletes the stored
 * heartbeat in the same transaction, so nothing about when the person was last around remains.
 * Showing starts with the next heartbeat. Same authority, receipt and retry rules as the visibility
 * command; its revision is its own, independent of the audience's.
 */
export function makeSetPresencePreference(p: VisibilityPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<Result<PreferenceAcceptance>> => {
    const parsed = SetPresencePreferenceSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const result = await p.withScope(authority, async (scope): Promise<Result<PreferenceAcceptance>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('unavailable');
      const accountId = gate.owner.accountId;
      const key = receiptKey(p, 'social.presence-preference-set', command);
      const receipt = await p.store.findReceipt(scope, key);
      if (receipt.kind === 'refused') return receipt;
      if (receipt.kind === 'replay')
        return {
          kind: 'ok',
          value: PresencePreferenceAcceptanceSchema.parse({
            ...PresencePreferenceAcceptanceSchema.parse(receipt.outcome),
            replayed: true,
          }),
        };
      const stored = await p.visibility.settings(scope, accountId);
      if (stored.presenceRevision !== command.expectedPresencePreferenceRevision) return refuse('stale_revision');
      const changed = stored.presencePreference !== command.preference;
      const presenceRevision = changed ? increment(stored.presenceRevision) : stored.presenceRevision;
      await p.store.beginReceipt(scope, key);
      if (changed) {
        await p.visibility.saveSettings(scope, accountId, {
          ...stored,
          presencePreference: command.preference,
          presenceRevision,
        });
        if (command.preference === 'hidden') await p.visibility.clearPresence(scope, accountId);
      }
      const value = PresencePreferenceAcceptanceSchema.parse({
        ...ownEnvelope(scope),
        commandId: command.commandId,
        recordedAt: p.now().toISOString(),
        replayed: false,
        outcome: 'accepted',
        operation: 'presence.preference.set',
        basePresencePreferenceRevision: stored.presenceRevision,
        acceptedPresencePreferenceRevision: presenceRevision,
      });
      await p.store.receipt(scope, key, value);
      return { kind: 'ok', value };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}
