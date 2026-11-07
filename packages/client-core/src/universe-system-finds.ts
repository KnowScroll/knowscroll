import { SystemFindsSchema, type SystemFind } from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import type { AccountScope } from './account-scope';

export type { SystemFind } from '@knowscroll/contracts';

export type SystemFindsRead =
  | { readonly status: 'ready'; readonly finds: readonly SystemFind[] }
  | {
      readonly status: 'unavailable';
      readonly reason: 'not_on_map' | 'network' | 'authority' | 'invalid' | 'temporarily_unavailable';
    };

const AUTHORITY_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SCOPE_MISMATCH',
  'PRIVACY_EPOCH_CHANGED',
  'UNIVERSE_UNAVAILABLE',
];

/**
 * Reads a system's Reels and Scrolls (`POST /v1/universe/system/finds/read`, #697), so the Universe can open them from a
 * system that has no planet yet.
 *
 * Authority: the actual scope's own session; the reply must name the same universe, epoch, read and system.
 * Side effects: none. Opening the list records nothing; a find is opened through its own address, which starts the real
 * encounter. Failure: a typed `unavailable` outcome, never retried here; the caller reads again when the list is opened.
 */
export async function readSystemFinds(
  scope: AccountScope,
  input: { readonly systemId: string; readonly readId: string },
  signal?: AbortSignal,
): Promise<SystemFindsRead> {
  if (!scope.active) return { status: 'unavailable', reason: 'authority' };
  try {
    const raw = await scope.api.geography.systemFinds(
      { version: 'universe-system-finds.v1', readId: input.readId, systemId: input.systemId },
      signal ? { signal } : undefined,
    );
    const parsed = SystemFindsSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.universeId !== scope.account.universeId ||
      parsed.data.privacyEpoch !== scope.account.privacyEpoch ||
      parsed.data.readId !== input.readId ||
      parsed.data.systemId !== input.systemId
    )
      return { status: 'unavailable', reason: 'invalid' };
    return parsed.data.status === 'ready'
      ? { status: 'ready', finds: parsed.data.finds }
      : { status: 'unavailable', reason: parsed.data.reason };
  } catch (error) {
    const problem = apiProblem(error);
    if (problem)
      return {
        status: 'unavailable',
        reason: AUTHORITY_CODES.includes(problem.code) ? 'authority' : 'temporarily_unavailable',
      };
    return { status: 'unavailable', reason: error instanceof TypeError ? 'network' : 'invalid' };
  }
}
