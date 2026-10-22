import {
  CreateFriendInviteSchema,
  RevokeFriendInviteSchema,
  ResolveFriendInviteSchema,
  OwnFriendInvitesSchema,
  FriendInviteAcceptanceSchema,
  CreateFriendInviteResultSchema,
  ResolvedFriendInviteSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { inviteStatus, INVITE_LIFETIME_MS } from '../domain/invites.js';
import { increment } from '../domain/friends.js';
import { publicPair } from './lookup-person.js';
import { ownEnvelope, refuse, type Result, type SocialPorts } from './ports.js';
export function makeInvites(p: SocialPorts) {
  return {
    async readInvites(authority: PersonalAuthority): Promise<Result<z.infer<typeof OwnFriendInvitesSchema>>> {
      const r = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const row = await p.invites.read(scope, { accountId: gate.owner.accountId });
        return {
          kind: 'ok' as const,
          value: OwnFriendInvitesSchema.parse({
            ...ownEnvelope(scope),
            invite: row
              ? { status: inviteStatus(row, p.now().getTime()), linkId: row.linkId, inviteRevision: row.revision }
              : { status: 'none', inviteRevision: 0 },
          }),
        };
      });
      return r.kind === 'entered' ? r.value : refuse('unavailable');
    },
    async createInvite(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof CreateFriendInviteResultSchema>>> {
      const parsed = CreateFriendInviteSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const q = parsed.data;
      const r = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active' || !(await p.store.profile(scope, { accountId: gate.owner.accountId })))
          return refuse('unavailable');
        const old = await p.invites.read(scope, { accountId: gate.owner.accountId });
        const operation = 'social.invite-create',
          key = { commandId: q.commandId, operation, outcomeVersion: 1, requestHash: p.hash(operation, q) };
        const found = await p.store.findReceipt(scope, key);
        if (found.kind === 'refused') return found;
        if (found.kind === 'replay') {
          const acceptance = FriendInviteAcceptanceSchema.parse({
            ...FriendInviteAcceptanceSchema.parse(found.outcome),
            replayed: true,
          });
          if (!old || old.linkId !== acceptance.linkId) return refuse('unavailable');
          return {
            kind: 'ok' as const,
            value: CreateFriendInviteResultSchema.parse({ acceptance, delivery: { status: 'unavailable' } }),
          };
        }
        const base = old?.revision ?? 0,
          now = p.now();
        if (base !== q.expectedInviteRevision) return refuse('stale_revision');
        if (old && inviteStatus(old, now.getTime()) === 'active') return refuse('unavailable');
        if (base >= Number.MAX_SAFE_INTEGER) return refuse('counter_exhausted');
        const token = p.secret(),
          linkId = p.newId(),
          revision = increment(base);
        const acceptance = FriendInviteAcceptanceSchema.parse({
          ...ownEnvelope(scope),
          commandId: q.commandId,
          recordedAt: now.toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'invite.create',
          linkId,
          baseInviteRevision: base,
          acceptedInviteRevision: revision,
        });
        await p.store.beginReceipt(scope, key);
        await p.invites.save(scope, {
          accountId: gate.owner.accountId,
          linkId,
          tokenHash: p.digest(token),
          revision,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS).toISOString(),
          revoked: false,
        });
        await p.store.receipt(scope, key, acceptance);
        return {
          kind: 'ok' as const,
          value: CreateFriendInviteResultSchema.parse({ acceptance, delivery: { status: 'available', token } }),
        };
      });
      return r.kind === 'entered' ? r.value : refuse('unavailable');
    },
    async revokeInvite(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof FriendInviteAcceptanceSchema>>> {
      const parsed = RevokeFriendInviteSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const q = parsed.data;
      const r = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const old = await p.invites.read(scope, { accountId: gate.owner.accountId });
        if (!old || old.linkId.toLowerCase() !== q.linkId.toLowerCase()) return refuse('unavailable');
        const operation = 'social.invite-revoke',
          key = { commandId: q.commandId, operation, outcomeVersion: 1, requestHash: p.hash(operation, q) };
        const found = await p.store.findReceipt(scope, key);
        if (found.kind === 'refused') return found;
        if (found.kind === 'replay')
          return {
            kind: 'ok' as const,
            value: FriendInviteAcceptanceSchema.parse({
              ...FriendInviteAcceptanceSchema.parse(found.outcome),
              replayed: true,
            }),
          };
        if (old.revision !== q.expectedInviteRevision) return refuse('stale_revision');
        if (!old.revoked && old.revision >= Number.MAX_SAFE_INTEGER) return refuse('counter_exhausted');
        const revision = old.revoked ? old.revision : increment(old.revision);
        const value = FriendInviteAcceptanceSchema.parse({
          ...ownEnvelope(scope),
          commandId: q.commandId,
          recordedAt: p.now().toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'invite.revoke',
          linkId: old.linkId,
          baseInviteRevision: old.revision,
          acceptedInviteRevision: revision,
        });
        await p.store.beginReceipt(scope, key);
        await p.invites.save(scope, { ...old, revision, revoked: true });
        await p.store.receipt(scope, key, value);
        return { kind: 'ok' as const, value };
      });
      return r.kind === 'entered' ? r.value : refuse('unavailable');
    },
    async resolveInvite(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ResolvedFriendInviteSchema>>> {
      const parsed = ResolveFriendInviteSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const hash = p.digest(parsed.data.token);
      const r = await p.withScope(authority, async (scope) => {
        const missing = () => ({
          kind: 'ok' as const,
          value: ResolvedFriendInviteSchema.parse({ ...ownEnvelope(scope), status: 'unavailable' }),
        });
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const initial = await p.invites.read(scope, { tokenHash: hash });
        if (!initial || initial.accountId === scope.authority.actor.accountId) return missing();
        const gate = await p.fencePair(scope, initial.accountId);
        if (gate.kind !== 'active') return missing();
        const invite = await p.invites.read(scope, { tokenHash: hash }),
          peer = await p.store.profile(scope, { accountId: initial.accountId });
        if (
          !invite ||
          invite.linkId !== initial.linkId ||
          invite.accountId !== gate.peer.accountId ||
          !peer ||
          inviteStatus(invite, p.now().getTime()) !== 'active'
        )
          return missing();
        const locked = await p.store.lockPair(scope, gate.owner.accountId, gate.peer.accountId, false);
        if (locked?.pair.sides.some((s) => s.blocked)) return missing();
        const view = publicPair(locked?.pair, gate.owner.accountId, peer.person, p.now().getTime());
        return {
          kind: 'ok' as const,
          value: ResolvedFriendInviteSchema.parse({
            ...ownEnvelope(scope),
            status: 'available',
            issuer: peer.person,
            pairRevision: view.pairRevision,
          }),
        };
      });
      return r.kind === 'entered' ? r.value : refuse('unavailable');
    },
  };
}
