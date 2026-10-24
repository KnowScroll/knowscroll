import type { DirectConversationRef } from '@knowscroll/contracts';

/** The address of a conversation: its ID, and the person's own membership reference to open it with. */
export function conversationHref(ref: DirectConversationRef): string {
  return `/conversations/${ref.conversationId}?m=${ref.membershipId}&r=${String(ref.membershipRevision)}`;
}

/** The reference a conversation address carries, or undefined when it has none (a link without `m`). */
export function conversationRefFromParams(params: {
  readonly conversationId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
}): DirectConversationRef | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const revision = Number(params.r ?? '1');
  if (!params.m || !uuid.test(params.m) || !uuid.test(params.conversationId)) return undefined;
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { conversationId: params.conversationId, membershipId: params.m, membershipRevision: revision };
}
