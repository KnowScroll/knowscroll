import type { ContentThreadRef } from '@knowscroll/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const carry = (ref: ContentThreadRef) => `?m=${ref.membershipId}&r=${String(ref.membershipRevision)}`;

/** The address of a thread: its ID, and the person's own membership reference to open it with. */
export const threadHref = (ref: ContentThreadRef): string => `/threads/${ref.threadId}${carry(ref)}`;

/** A snippet's viewer, a focused screen over the thread (H03). Back returns to the same message. */
export const snippetHref = (ref: ContentThreadRef, messageId: string): string =>
  `/threads/${ref.threadId}/snippet/${messageId}${carry(ref)}`;

/**
 * The thread's own reader of one of its Scrolls, where a passage or block can be shared back into the thread.
 * In a series it carries the part's number (`p`), so the reader can tell the thread the person finished it.
 */
export const readInThreadHref = (ref: ContentThreadRef, assetId: string, part?: number): string =>
  `/threads/${ref.threadId}/read/${assetId}${carry(ref)}${part === undefined ? '' : `&p=${String(part)}`}`;

/** The part a reader address names, or undefined when it names none or something that is not a part. */
export function partFromParam(value: string | undefined): number | undefined {
  const part = Number(value);
  return value !== undefined && Number.isInteger(part) && part >= 1 && part <= 99 ? part : undefined;
}

/** A branch of the thread (X03): its own items, with a way back to the original sequence. */
export const branchHref = (ref: ContentThreadRef, nodeId: string): string =>
  `/threads/${ref.threadId}/b/${nodeId}${carry(ref)}`;

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
