import type { CheckAssetAudience, ResolveSnippetAnchor, ValidateSnippetAnchor } from '../../content/public.js';

/**
 * A snippet names a Scroll by ID, and checking or opening it quotes that Scroll's words back. A Scroll
 * made for a thread (D-049) is quoted only to those in that thread: for anyone else it is as unavailable
 * as a Scroll that does not exist. Both reads run inside the thread's transaction, so the check reads on
 * it too and takes no second connection.
 */
export function gateSnippetAnchors(
  check: CheckAssetAudience,
  validate: ValidateSnippetAnchor,
  resolve: ResolveSnippetAnchor,
): { readonly validateSnippet: ValidateSnippetAnchor; readonly resolveSnippet: ResolveSnippetAnchor } {
  const reaches = async (scope: Parameters<ValidateSnippetAnchor>[0], assetId: string) =>
    (await check({ scope }, scope.authority, [assetId])).has(assetId);
  return {
    validateSnippet: async (scope, target, anchor) =>
      (await reaches(scope, target.assetId)) ? validate(scope, target, anchor) : { status: 'unavailable' },
    resolveSnippet: async (scope, target, anchor) =>
      (await reaches(scope, target.assetId)) ? resolve(scope, target, anchor) : { status: 'unavailable' },
  };
}
