import type { ContentThreadRef } from '@knowscroll/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const carry = (ref: ContentThreadRef) => `?m=${ref.membershipId}&r=${String(ref.membershipRevision)}`;

/** The address of a thread: its ID, and the person's own membership reference to open it with. */
export const threadHref = (ref: ContentThreadRef): string => `/threads/${ref.threadId}${carry(ref)}`;

/** A snippet's viewer, a focused screen over the thread (H03). Back returns to the same message. */
export const snippetHref = (ref: ContentThreadRef, messageId: string): string =>
  `/threads/${ref.threadId}/snippet/${messageId}${carry(ref)}`;

/**
 * The thread's own reader of one of its Scrolls, where a passage or block can be shared back. A
 * branch's Scroll is read here too, without the share control: a passage of a branch cannot be
 * shared yet, because a snippet points into the thread's own sequence.
 */
export const readInThreadHref = (
  ref: ContentThreadRef,
  assetId: string,
  options: { readonly branch?: boolean } = {},
): string => `/threads/${ref.threadId}/read/${assetId}${carry(ref)}${options.branch === true ? '&b=1' : ''}`;

/** The reference a thread address carries, or undefined when it has none (a link without `m`). */
export function threadRefFromParams(params: {
  readonly threadId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
}): ContentThreadRef | undefined {
  const revision = Number(params.r ?? '1');
  if (!params.m || !UUID.test(params.m) || !UUID.test(params.threadId)) return undefined;
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { threadId: params.threadId, membershipId: params.m, membershipRevision: revision };
}
