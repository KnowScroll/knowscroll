import {
  CreateContentShareSchema,
  CreateContentShareResultSchema,
  RevokeContentShareSchema,
  ContentShareRevocationAcceptanceSchema,
  ReadOwnContentShareSchema,
  OwnContentShareSchema,
  ResolveContentShareSchema,
  ResolvedContentShareSchema,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { SocialHttpError, sameContent, sameSocialScope, socialFailure } from './conversations-http';
import {
  freezeSocial,
  sameConversation,
  sameSocialId,
  socialData,
  SOCIAL_LIMITS,
  type ShareInput,
  type ShareOperation,
  type ShareOutput,
} from './conversations-types';
const inputs = {
  create: CreateContentShareSchema,
  revoke: RevokeContentShareSchema,
  own: ReadOwnContentShareSchema,
  resolve: ResolveContentShareSchema,
};
const outputs = {
  create: CreateContentShareResultSchema,
  revoke: ContentShareRevocationAcceptanceSchema,
  own: OwnContentShareSchema,
  resolve: ResolvedContentShareSchema,
};
function bound<K extends ShareOperation>(
  scope: AccountScope,
  operation: K,
  input: ShareInput<K>,
  output: ShareOutput<K>,
): boolean {
  if (operation === 'create') {
    const a = input as ShareInput<'create'>,
      b = (output as ShareOutput<'create'>).acceptance;
    return (
      sameSocialScope(scope, b.scope) &&
      sameSocialId(a.commandId, b.commandId) &&
      sameContent(a.target, b.target) &&
      a.audience.kind === b.audience.kind &&
      (a.audience.kind !== 'conversation' ||
        (b.audience.kind === 'conversation' && sameConversation(a.audience.conversation, b.audience.conversation)))
    );
  }
  if (operation === 'revoke') {
    const a = input as ShareInput<'revoke'>,
      b = output as ShareOutput<'revoke'>;
    return (
      sameSocialScope(scope, b.scope) && sameSocialId(a.commandId, b.commandId) && sameSocialId(a.shareId, b.shareId)
    );
  }
  if (operation === 'own') {
    const a = input as ShareInput<'own'>,
      b = output as ShareOutput<'own'>;
    return (
      sameSocialScope(scope, b.scope) &&
      sameSocialId(a.readId, b.readId) &&
      a.selector.kind === b.selector.kind &&
      (a.selector.kind === 'share'
        ? b.selector.kind === 'share' &&
          sameSocialId(a.selector.shareId, b.selector.shareId) &&
          (b.status !== 'available' || sameSocialId(b.shareId, a.selector.shareId))
        : b.selector.kind === 'command' && sameSocialId(a.selector.commandId, b.selector.commandId))
    );
  }
  const a = input as ShareInput<'resolve'>,
    b = output as ShareOutput<'resolve'>;
  return sameSocialId(a.readId, b.readId) && (b.status !== 'conversation' || sameSocialScope(scope, b.scope));
}
/** Private JSON resolver only; never public union fallback or a URL/token builder. */
export function createContentSharesHttp(scope: AccountScope) {
  function prepare<K extends ShareOperation>(operation: K, input: ShareInput<K>): ShareInput<K> {
    if (!socialData(input)) throw new SocialHttpError('invalid', false);
    const parsed = inputs[operation].safeParse(input);
    if (!parsed.success) throw new SocialHttpError('invalid', false);
    return freezeSocial(parsed.data as ShareInput<K>);
  }
  return {
    prepare,
    call<K extends ShareOperation>(operation: K, input: ShareInput<K>, signal?: AbortSignal): Promise<ShareOutput<K>> {
      // The only retained request copy is an explicitly purgeable cell. Request serialization/
      // transport owns its already-dispatched bytes; no controller cache or recovery survives end.
      const request: { value?: ShareInput<K> } = {};
      let off: (() => void) | undefined;
      const purge = () => {
        request.value = undefined;
      };
      const cleanup = () => {
        purge();
        off?.();
        signal?.removeEventListener('abort', purge);
      };
      try {
        if (!scope.active || signal?.aborted || typeof scope.onEnd !== 'function')
          throw new SocialHttpError('authority', false);
        request.value = prepare(operation, input);
        off = scope.onEnd(purge);
        signal?.addEventListener('abort', purge, { once: true });
        if (!request.value || !scope.active || signal?.aborted) throw new SocialHttpError('authority', false);
        const method = scope.api.contentShares[operation] as (
          body: ShareInput<K>,
          options: { signal?: AbortSignal },
        ) => Promise<unknown>;
        return method(request.value, signal ? { signal } : {})
          .then(
            (raw: unknown) => {
              if (!scope.active || signal?.aborted || !request.value) throw new SocialHttpError('authority', true);
              try {
                if (
                  !socialData(raw) ||
                  new TextEncoder().encode(JSON.stringify(raw)).length > SOCIAL_LIMITS.responseBytes
                )
                  throw new Error();
                const parsed = outputs[operation].safeParse(raw);
                if (!parsed.success || !bound(scope, operation, request.value, parsed.data as ShareOutput<K>))
                  throw new Error();
                return freezeSocial(parsed.data as ShareOutput<K>);
              } catch {
                throw new SocialHttpError('invalid', true);
              }
            },
            (error: unknown) => {
              throw socialFailure(error);
            },
          )
          .finally(cleanup);
      } catch (error) {
        cleanup();
        return Promise.reject(error instanceof SocialHttpError ? error : socialFailure(error));
      }
    },
  };
}
