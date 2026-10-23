import {
  StartDirectConversationSchema, DirectConversationAcceptanceSchema, ReadConversationInboxSchema, ConversationInboxSchema,
  ReadDirectConversationSchema, DirectConversationSnapshotSchema, ReadConversationHistorySchema, ConversationHistoryPageSchema,
  ReadConversationChangesSchema, ConversationChangesPageSchema, SendConversationMessageSchema, ConversationMessageAcceptanceSchema,
  ReadOwnConversationSendSchema, OwnConversationSendSchema, MarkConversationReadSchema, ConversationReadAcceptanceSchema,
  MuteConversationSchema, ConversationMuteAcceptanceSchema, LeaveConversationSchema, ConversationLeaveAcceptanceSchema,
  ownConversationSendForRead,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { apiProblem } from './api-client';
import { freezeSocial, sameSocialId, sameConversation, socialData, SOCIAL_LIMITS, type SocialFailure, type ConversationInput, type ConversationOperation, type ConversationOutput } from './conversations-types';
const inputs = { start: StartDirectConversationSchema, inbox: ReadConversationInboxSchema, read: ReadDirectConversationSchema, history: ReadConversationHistorySchema, changes: ReadConversationChangesSchema, send: SendConversationMessageSchema, readOwnSend: ReadOwnConversationSendSchema, markRead: MarkConversationReadSchema, mute: MuteConversationSchema, leave: LeaveConversationSchema };
const outputs = { start: DirectConversationAcceptanceSchema, inbox: ConversationInboxSchema, read: DirectConversationSnapshotSchema, history: ConversationHistoryPageSchema, changes: ConversationChangesPageSchema, send: ConversationMessageAcceptanceSchema, readOwnSend: OwnConversationSendSchema, markRead: ConversationReadAcceptanceSchema, mute: ConversationMuteAcceptanceSchema, leave: ConversationLeaveAcceptanceSchema };
const operations = { start: 'conversation.start', send: 'message.send', markRead: 'conversation.read', mute: 'conversation.mute', leave: 'conversation.leave' };
export class SocialHttpError extends Error {
  constructor(readonly reason: SocialFailure, readonly ambiguous: boolean) { super('Social request unavailable'); }
}
export function socialFailure(error: unknown): SocialHttpError {
  if (error instanceof SocialHttpError) return error;
  try {
    const p = apiProblem(error);
    if (!p) return new SocialHttpError('network', true);
    const authority = ['UNAUTHENTICATED', 'FORBIDDEN', 'SCOPE_MISMATCH', 'PRIVACY_EPOCH_CHANGED', 'UNIVERSE_UNAVAILABLE'].includes(p.code);
    return new SocialHttpError(authority ? 'authority' : p.code === 'SHARING_REVISION_STALE' ? 'refresh_required' : 'unavailable', p.status >= 500);
  } catch { return new SocialHttpError('unavailable', true); }
}
export function sameSocialScope(scope: AccountScope, x: { accountId: string; privacyEpoch: number }): boolean {
  return sameSocialId(scope.account.accountId, x.accountId) && scope.account.privacyEpoch === x.privacyEpoch;
}
export function sameContent(a: { assetId: string; assetRevision: number }, b: { assetId: string; assetRevision: number }): boolean {
  return sameSocialId(a.assetId, b.assetId) && a.assetRevision === b.assetRevision;
}
function binding<K extends ConversationOperation>(scope: AccountScope, operation: K, input: ConversationInput<K>, output: ConversationOutput<K>): boolean {
  // A closed discriminated dispatch keeps the exact protocol bindings visible.
  const a = input as ConversationInput<ConversationOperation>, b = output as ConversationOutput<ConversationOperation>;
  if (!sameSocialScope(scope, b.scope)) return false;
  if ('readId' in a && (!('readId' in b) || !sameSocialId(a.readId, b.readId))) return false;
  if ('commandId' in a && (!('commandId' in b) || !sameSocialId(a.commandId, b.commandId) || !('operation' in b) || b.operation !== operations[operation as keyof typeof operations])) return false;
  if ('conversation' in a && 'conversation' in b && !sameConversation(a.conversation, b.conversation)) return false;
  if (operation === 'start') return 'peerPersonId' in a && 'peerPersonId' in b && sameSocialId(a.peerPersonId, b.peerPersonId);
  if ('limit' in a && 'limit' in b && a.limit !== b.limit) return false;
  if ('requestCursor' in b && b.requestCursor !== ('cursor' in a ? a.cursor : undefined)) return false;
  if (operation === 'inbox' && 'status' in b && b.status === 'ready' && 'items' in b) {
    return b.items.length <= (input as ConversationInput<'inbox'>).limit && new Set(b.items.map((i) => i.conversation.conversationId.toLowerCase())).size === b.items.length;
  }
  if (operation === 'send') {
    const x = input as ConversationInput<'send'>, y = output as ConversationOutput<'send'>;
    return x.body.kind === y.sent.kind && (x.body.kind !== 'content' || (y.sent.kind === 'content' && sameContent(x.body.target, y.sent.target)));
  }
  if (operation === 'mute') return (input as ConversationInput<'mute'>).muted === (output as ConversationOutput<'mute'>).muted;
  if (operation === 'markRead') return (input as ConversationInput<'markRead'>).throughSequence === (output as ConversationOutput<'markRead'>).requestedThroughSequence;
  if (operation === 'readOwnSend') return !!ownConversationSendForRead(input, output, { scope: { accountId: scope.account.accountId, privacyEpoch: scope.account.privacyEpoch }, conversation: (input as ConversationInput<'readOwnSend'>).conversation });
  return true;
}
/** Semantic UUID uniqueness/remapping checks supplement case-sensitive wire refinements. */
export function stableSocialMessages(items: readonly { messageId: string; sequence: number }[], repeated = false): boolean {
  const ids = new Map<string, number>(), seqs = new Map<number, string>();
  for (const item of items) {
    const id = item.messageId.toLowerCase();
    if ((ids.has(id) && (!repeated || ids.get(id) !== item.sequence)) || (seqs.has(item.sequence) && seqs.get(item.sequence) !== id)) return false;
    ids.set(id, item.sequence); seqs.set(item.sequence, id);
  }
  return true;
}
/** Actual fenced scope.api only. No retry/cache/storage, raw fetch or public fallback. */
export function createConversationsHttp(scope: AccountScope) {
  function prepare<K extends ConversationOperation>(operation: K, input: ConversationInput<K>): ConversationInput<K> {
    if (!socialData(input)) throw new SocialHttpError('invalid', false);
    const parsed = inputs[operation].safeParse(input);
    if (!parsed.success) throw new SocialHttpError('invalid', false);
    return freezeSocial(parsed.data as ConversationInput<K>);
  }
  return { prepare, async call<K extends ConversationOperation>(operation: K, input: ConversationInput<K>, signal?: AbortSignal): Promise<ConversationOutput<K>> {
    if (!scope.active || signal?.aborted) throw new SocialHttpError('authority', false);
    const prepared = prepare(operation, input);
    let raw: unknown;
    try {
      const method = scope.api.conversations[operation] as (body: ConversationInput<K>, options: { signal?: AbortSignal }) => Promise<unknown>;
      raw = await method(prepared, signal ? { signal } : {});
    } catch (e) { throw socialFailure(e); }
    if (!scope.active || signal?.aborted) throw new SocialHttpError('authority', true);
    try {
      if (!socialData(raw) || new TextEncoder().encode(JSON.stringify(raw)).length > SOCIAL_LIMITS.responseBytes) throw new Error();
      const parsed = outputs[operation].safeParse(raw);
      if (!parsed.success || !binding(scope, operation, prepared, parsed.data as ConversationOutput<K>)) throw new Error();
      const b = parsed.data;
      if ('messages' in b && !stableSocialMessages(b.messages)) throw new Error();
      if ('changes' in b && !stableSocialMessages(b.changes.map((c) => c.message), true)) throw new Error();
      return freezeSocial(parsed.data as ConversationOutput<K>);
    } catch { throw new SocialHttpError('invalid', true); }
  } };
}
