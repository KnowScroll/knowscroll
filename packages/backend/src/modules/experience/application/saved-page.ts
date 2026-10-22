import {
  SavedPageRequestSchema,
  SavedPageResponseSchema,
  SavedPageItemSchema,
  type KeepEntryRef,
  type SavedPageRequest,
  type SavedPageResponse,
} from '@knowscroll/contracts';
import type { FenceOwnAccount, PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ReadSavedPageMetadata } from '../../content/public.js';

export const SAVED_CANDIDATE_LIMIT = 100;
export interface SavedPageKey {
  readonly savedAt: string;
  readonly assetId: string;
}
export interface SavedCursorBinding {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly filter: SavedPageRequest['filter'];
  readonly limit: number;
}
/** Opaque codec only: the API composes a purpose/world-bound per-instance key, never the use case. */
export interface SavedCursorCodec {
  mint(this: void, binding: SavedCursorBinding, after: SavedPageKey): string;
  read(this: void, binding: SavedCursorBinding, token: string): SavedPageKey | undefined;
}
export interface SavedCandidate {
  readonly entry: KeepEntryRef;
  readonly key: SavedPageKey;
}
export interface SavedPagePorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly codec: SavedCursorCodec;
  readonly candidates: (
    scope: PersonalScopeTx,
    after?: SavedPageKey,
  ) => Promise<{
    readonly items: readonly SavedCandidate[];
    readonly more: boolean;
  }>;
  readonly metadata: ReadSavedPageMetadata;
}
export type SavedPageResult =
  | { readonly kind: 'ok'; readonly value: SavedPageResponse }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'INVALID_REQUEST'
        | 'UNIVERSE_UNAVAILABLE'
        | 'PRIVACY_EPOCH_CHANGED'
        | 'SAVED_CURSOR_UNAVAILABLE'
        | 'SERVICE_UNAVAILABLE';
    };
const refused = (code: Extract<SavedPageResult, { kind: 'refused' }>['code']): SavedPageResult => ({
  kind: 'refused',
  code,
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Current authority and Clear barrier precede cursor inspection. Reads never advance a root,
 * write a receipt/job or freeze shared Content/membership into a retained list snapshot. */
export function makeSavedPage(p: SavedPagePorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<SavedPageResult> => {
    const parsed = SavedPageRequestSchema.safeParse(input);
    if (!parsed.success) return refused('INVALID_REQUEST');
    const request = parsed.data,
      limit = Number(request.limit);
    const entered = await p.withScope(authority, async (scope): Promise<SavedPageResult> => {
      if (scope.authority.actor.kind !== 'account') return refused('UNIVERSE_UNAVAILABLE');
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refused('UNIVERSE_UNAVAILABLE');
      const binding: SavedCursorBinding = {
        accountId: scope.authority.actor.accountId,
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        filter: request.filter,
        limit,
      };
      const after = request.cursor ? p.codec.read(binding, request.cursor) : undefined;
      if (request.cursor && !after) return refused('SAVED_CURSOR_UNAVAILABLE');
      const window = await p.candidates(scope, after);
      if (window.items.length > SAVED_CANDIDATE_LIMIT || (!window.items.length && window.more))
        return refused('SERVICE_UNAVAILABLE');
      const metadata = await p.metadata(
        scope,
        window.items.map((item) => ({ assetId: item.entry.assetId, assetRevision: item.entry.assetRevision })),
      );
      if (metadata.length !== window.items.length) return refused('SERVICE_UNAVAILABLE');
      const items: SavedPageResponse['items'] = [];
      let consumed = 0;
      for (const candidate of window.items) {
        const facts = metadata[consumed];
        if (
          !facts ||
          !same(facts.ref.assetId, candidate.entry.assetId) ||
          facts.ref.assetRevision !== candidate.entry.assetRevision ||
          !same(candidate.key.assetId, candidate.entry.assetId)
        )
          return refused('SERVICE_UNAVAILABLE');
        consumed++;
        if (request.filter !== 'all' && facts.kind !== request.filter) continue;
        const item = SavedPageItemSchema.safeParse({
          ...candidate.entry,
          savedAt: candidate.key.savedAt,
          kind: facts.kind,
          availability: facts.availability,
          ...(facts.metadata ? { metadata: facts.metadata } : {}),
          ...(facts.currentAssetRevision !== undefined ? { currentAssetRevision: facts.currentAssetRevision } : {}),
        });
        if (!item.success) return refused('SERVICE_UNAVAILABLE');
        items.push(item.data);
        if (items.length === limit) break;
      }
      const last = window.items[consumed - 1];
      const more = !!last && (consumed < window.items.length || window.more);
      const response = SavedPageResponseSchema.safeParse({
        pagination: 'saved-page.v1',
        consistency: 'live',
        scope: { accountId: binding.accountId, privacyEpoch: binding.privacyEpoch },
        filter: request.filter,
        limit,
        revision: scope.revisionAtEntry,
        items,
        ...(request.cursor ? { requestCursor: request.cursor } : {}),
        continuation: more ? { status: 'more', cursor: p.codec.mint(binding, last.key) } : { status: 'end' },
      });
      return response.success ? { kind: 'ok', value: response.data } : refused('SERVICE_UNAVAILABLE');
    });
    return entered.kind === 'entered'
      ? entered.value
      : refused(entered.refusal.kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
  };
}
export type ReadSavedPage = ReturnType<typeof makeSavedPage>;
