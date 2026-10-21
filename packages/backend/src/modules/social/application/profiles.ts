import {
  OwnSharingProfileSchema,
  SetSharingProfileSchema,
  SharingProfileAcceptanceSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { increment } from '../domain/friends.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';
type Read = z.infer<typeof OwnSharingProfileSchema>;
type Acceptance = z.infer<typeof SharingProfileAcceptanceSchema>;
export function makeReadProfile(p: SocialPorts) {
  return async (authority: PersonalAuthority): Promise<Result<Read>> => {
    const result = await p.withScope(authority, async (scope): Promise<Result<Read>> => {
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active' || scope.authority.actor.kind !== 'account') return refuse('unavailable');
      const profile = await p.store.profile(scope, { accountId: gate.owner.accountId });
      return {
        kind: 'ok',
        value: OwnSharingProfileSchema.parse(
          profile
            ? { ...ownEnvelope(scope), status: 'claimed', profileRevision: profile.revision, person: profile.person }
            : { ...ownEnvelope(scope), status: 'unclaimed', profileRevision: 0 },
        ),
      };
    });
    return result.kind === 'entered' ? result.value : refuse('unavailable');
  };
}
export function makeSetProfile(p: SocialPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<Result<Acceptance>> => {
    const parsed = SetSharingProfileSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    try {
      const result = await p.withScope(authority, async (scope): Promise<Result<Acceptance>> => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active' || scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const key = {
          commandId: command.commandId,
          operation: 'social.profile-set',
          outcomeVersion: 1,
          requestHash: p.hash('social.profile-set', command),
        };
        const receipt = await p.store.findReceipt(scope, key);
        if (receipt.kind === 'refused') return receipt;
        if (receipt.kind === 'replay')
          return {
            kind: 'ok',
            value: SharingProfileAcceptanceSchema.parse({
              ...SharingProfileAcceptanceSchema.parse(receipt.outcome),
              replayed: true,
            }),
          };
        const old = await p.store.profile(scope, { accountId: gate.owner.accountId });
        const base = old?.revision ?? 0;
        if (base !== command.expectedProfileRevision) return refuse('stale_revision');
        if (base >= Number.MAX_SAFE_INTEGER) return refuse('counter_exhausted');
        const taken = await p.store.profile(scope, { handle: command.handle });
        if (taken && taken.accountId !== gate.owner.accountId) return refuse('unavailable');
        const revision = increment(base);
        await p.store.beginReceipt(scope, key);
        await p.store.saveProfile(scope, {
          accountId: gate.owner.accountId,
          revision,
          person: {
            kind: 'person',
            personId: old?.person.personId ?? p.newId(),
            handle: command.handle,
            displayName: command.displayName,
          },
        });
        const value = SharingProfileAcceptanceSchema.parse({
          ...ownEnvelope(scope),
          commandId: command.commandId,
          recordedAt: p.now().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'profile.set',
          baseProfileRevision: base,
          acceptedProfileRevision: revision,
        });
        await p.store.receipt(scope, key, value);
        return { kind: 'ok', value };
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    } catch (error) {
      // Concurrent claims of the same unique handle roll the WHOLE transaction back.
      if (error instanceof Error && error.message === 'SOCIAL_HANDLE_TAKEN') return refuse('unavailable');
      throw error;
    }
  };
}
