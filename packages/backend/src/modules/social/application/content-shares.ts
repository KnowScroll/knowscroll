import {
  ContentShareCreationAcceptanceSchema,
  ContentShareRevocationAcceptanceSchema,
  CreateContentShareResultSchema,
  CreateContentShareSchema,
  ListOwnContentSharesSchema,
  OwnContentShareSchema,
  OwnContentSharesSchema,
  PublicContentSharePreviewSchema,
  ReadOwnContentShareSchema,
  ReadPublicContentSharePreviewSchema,
  ResolveContentShareSchema,
  ResolvedContentShareSchema,
  RevokeContentShareSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { SHARE_LIFETIME_MS, shareState } from '../domain/conversations.js';
import type { ContentCard, ConversationPorts, ShareRow } from './conversation-ports.js';
import { conversationEnvelope, refuse, type Result } from './ports.js';

const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
const LIST_LIMIT = 50;

/** A card the share surfaces may show: the content exists now, either as shared or corrected since. */
type ShownCard = Exclude<ContentCard, { status: 'unavailable' }>;
const shown = (card: ContentCard | undefined): card is ShownCard => card !== undefined && card.status !== 'unavailable';

/**
 * Managed share links to one exact content revision. The link's token is a bearer secret: it is
 * returned once, on the first response of the creating command, and only its hash is stored.
 * Opening a link never joins anything and creates no evidence. Access is decided on every read:
 * a revoked, expired or withdrawn link, an unknown token, and a private link seen by a stranger
 * are one indistinguishable `unavailable`. External copies of a link cannot be recalled; revoking
 * stops this server from answering for it.
 */
export function makeContentShares(p: ConversationPorts) {
  /** Who a link is for now. A private link whose conversation the owner no longer belongs to has no audience. */
  async function audienceOf(scope: PersonalScopeTx, share: ShareRow, accountId: string) {
    if (share.conversationId === null) return { kind: 'public_metadata' } as const;
    const membership = await p.shares.openMembership(scope, accountId, share.conversationId);
    return (
      membership &&
      ({ kind: 'conversation', conversation: { conversationId: share.conversationId, ...membership } } as const)
    );
  }

  return {
    /** Creates a public-metadata link, or a link private to a conversation the caller belongs to. */
    async create(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof CreateContentShareResultSchema>>> {
      const parsed = CreateContentShareSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const command = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const operation = 'social.content-share-create';
        const key = {
          commandId: command.commandId,
          operation,
          outcomeVersion: 1,
          requestHash: p.hash(operation, command),
        };
        const receipt = await p.store.findReceipt(scope, key);
        if (receipt.kind === 'refused') return receipt;
        if (receipt.kind === 'replay') {
          // The first response carried the only copy of the token; a retry recovers the same link without it.
          const acceptance = ContentShareCreationAcceptanceSchema.parse({
            ...ContentShareCreationAcceptanceSchema.parse(receipt.outcome),
            replayed: true,
          });
          const existing = await p.shares.byId(scope, acceptance.shareId);
          if (!existing || existing.ownerAccountId !== gate.owner.accountId) return refuse('unavailable');
          return ok(CreateContentShareResultSchema.parse({ acceptance, delivery: { status: 'unavailable' } }));
        }
        const [card] = await p.shares.cards(scope, [command.target]);
        if (!shown(card)) return refuse('unavailable');
        let conversationId: string | null = null;
        if (command.audience.kind === 'conversation') {
          const reference = command.audience.conversation;
          const membership = await p.shares.openMembership(scope, gate.owner.accountId, reference.conversationId);
          if (
            !membership ||
            membership.membershipId !== reference.membershipId ||
            membership.membershipRevision !== reference.membershipRevision
          )
            return refuse('unavailable');
          conversationId = reference.conversationId;
        }
        const now = p.now();
        const share = {
          shareId: p.newId(),
          ownerAccountId: gate.owner.accountId,
          commandId: command.commandId,
          target: command.target,
          conversationId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SHARE_LIFETIME_MS),
          revokedAt: null,
        };
        const token = p.shareToken();
        const acceptance = ContentShareCreationAcceptanceSchema.parse({
          ...conversationEnvelope(scope),
          commandId: command.commandId,
          recordedAt: now.toISOString(),
          replayed: false,
          outcome: 'accepted',
          shareId: share.shareId,
          operation: 'content-share.create',
          target: command.target,
          audience: command.audience,
          expiresAt: share.expiresAt.toISOString(),
        });
        await p.store.beginReceipt(scope, key);
        await p.shares.insert(scope, { ...share, tokenHash: p.digest(token) });
        await p.store.receipt(scope, key, acceptance);
        return ok(CreateContentShareResultSchema.parse({ acceptance, delivery: { status: 'available', token } }));
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** Stops this server from answering for the link. Revoking again is accepted and changes nothing. */
    async revoke(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ContentShareRevocationAcceptanceSchema>>> {
      const parsed = RevokeContentShareSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const command = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const operation = 'social.content-share-revoke';
        const key = {
          commandId: command.commandId,
          operation,
          outcomeVersion: 1,
          requestHash: p.hash(operation, command),
        };
        const receipt = await p.store.findReceipt(scope, key);
        if (receipt.kind === 'refused') return receipt;
        if (receipt.kind === 'replay')
          return ok({ ...ContentShareRevocationAcceptanceSchema.parse(receipt.outcome), replayed: true });
        const share = await p.shares.byId(scope, command.shareId);
        if (!share || share.ownerAccountId !== gate.owner.accountId) return refuse('unavailable');
        const now = p.now();
        const acceptance = ContentShareRevocationAcceptanceSchema.parse({
          ...conversationEnvelope(scope),
          commandId: command.commandId,
          recordedAt: now.toISOString(),
          replayed: false,
          outcome: 'accepted',
          shareId: share.shareId,
          operation: 'content-share.revoke',
        });
        await p.store.beginReceipt(scope, key);
        await p.shares.revoke(scope, share.shareId, now);
        await p.store.receipt(scope, key, acceptance);
        return ok(acceptance);
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** One of the caller's own links, by link or by creating command; it still reads after Clear. */
    async readOwn(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof OwnContentShareSchema>>> {
      const parsed = ReadOwnContentShareSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const envelope = {
          version: query.version,
          readId: query.readId,
          scope: conversationEnvelope(scope).scope,
          selector: query.selector,
        };
        const share =
          query.selector.kind === 'share'
            ? await p.shares.byId(scope, query.selector.shareId)
            : await p.shares.byCommand(scope, gate.owner.accountId, query.selector.commandId);
        const audience =
          share && share.ownerAccountId === gate.owner.accountId
            ? await audienceOf(scope, share, gate.owner.accountId)
            : undefined;
        if (!share || !audience) return ok(OwnContentShareSchema.parse({ ...envelope, status: 'unavailable' }));
        const state = shareState(share, p.now());
        return ok(
          OwnContentShareSchema.parse({
            ...envelope,
            status: 'available',
            shareId: share.shareId,
            target: share.target,
            audience,
            state: state === 'live' ? 'active' : state,
            expiresAt: share.expiresAt.toISOString(),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** The caller's live links, newest first, with what each points at now. */
    async list(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof OwnContentSharesSchema>>> {
      const parsed = ListOwnContentSharesSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope) => {
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const shares = await p.shares.live(scope, gate.owner.accountId, p.now(), LIST_LIMIT);
        const cards =
          shares.length === 0
            ? []
            : await p.shares.cards(
                scope,
                shares.map((share) => share.target),
              );
        const items = [];
        for (const [index, share] of shares.entries()) {
          const audience = await audienceOf(scope, share, gate.owner.accountId);
          if (audience)
            items.push({
              shareId: share.shareId,
              target: share.target,
              audience,
              createdAt: share.createdAt.toISOString(),
              expiresAt: share.expiresAt.toISOString(),
              content: cards[index],
            });
        }
        return ok(
          OwnContentSharesSchema.parse({
            version: parsed.data.version,
            readId: parsed.data.readId,
            scope: conversationEnvelope(scope).scope,
            items,
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * What a signed-in person sees behind a token: public metadata for a public link, the shared
     * card plus their own conversation reference for a private link they belong to, otherwise
     * `unavailable`. The conversation reference is for opening the thread, nothing more.
     */
    async resolve(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ResolvedContentShareSchema>>> {
      const parsed = ResolveContentShareSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const unavailable = () =>
          ok(ResolvedContentShareSchema.parse({ version: query.version, readId: query.readId, status: 'unavailable' }));
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const share = await p.shares.byTokenHash(scope, p.digest(query.token));
        if (!share || shareState(share, p.now()) !== 'live') return unavailable();
        const [card] = await p.shares.cards(scope, [share.target]);
        if (!shown(card)) return unavailable();
        const base = { version: query.version, readId: query.readId };
        if (share.conversationId === null)
          return ok(ResolvedContentShareSchema.parse({ ...base, status: 'public_metadata', content: card }));
        const membership = await p.shares.openMembership(scope, scope.authority.actor.accountId, share.conversationId);
        if (!membership) return unavailable();
        return ok(
          ResolvedContentShareSchema.parse({
            ...base,
            status: 'conversation',
            scope: conversationEnvelope(scope).scope,
            conversation: { conversationId: share.conversationId, ...membership },
            content: card,
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * The public page of a link for someone with no account: public metadata of a live public
     * link, otherwise `unavailable`. A private link is `unavailable` here too, so this answer
     * cannot reveal that a conversation exists. No scope, receipt or evidence is involved.
     */
    async previewPublic(input: unknown): Promise<Result<z.infer<typeof PublicContentSharePreviewSchema>>> {
      const parsed = ReadPublicContentSharePreviewSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const base = { version: query.version, readId: query.readId };
      const share = await p.shares.anonymous.byTokenHash(p.digest(query.token));
      if (!share || share.conversationId !== null || shareState(share, p.now()) !== 'live')
        return ok(PublicContentSharePreviewSchema.parse({ ...base, status: 'unavailable' }));
      const [card] = await p.shares.anonymous.cards([share.target]);
      if (!shown(card)) return ok(PublicContentSharePreviewSchema.parse({ ...base, status: 'unavailable' }));
      return ok(PublicContentSharePreviewSchema.parse({ ...base, status: 'public_metadata', content: card }));
    },
  };
}
