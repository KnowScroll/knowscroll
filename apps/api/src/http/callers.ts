import type { AuthAdapter } from '@knowscroll/backend/infrastructure/config';
import type { PersonalAuthority, ReadAccountUniverse } from '@knowscroll/backend/modules/identity';

/** The authenticated person behind a request or socket, as a claim to be rechecked under lock. */
export interface Caller {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
}

/**
 * The AuthenticatedCaller port: resolves an `Authorization` header value to a caller, or nothing.
 * S1.3 implements it with real sessions (D-007). Until then the API runs with `none` (every
 * personal route answers 401), and CI runs with the test-only adapter below.
 */
export interface AuthenticatedCallers {
  resolve(authorization: string | undefined): Promise<Caller | undefined>;
}

/** The claim a caller makes on its personal universe; `withPersonalScope` rechecks it. */
export function authorityOf(caller: Caller): PersonalAuthority {
  return {
    universeId: caller.universeId,
    privacyEpoch: caller.privacyEpoch,
    actor: { kind: 'account', accountId: caller.accountId },
  };
}

const noCallers: AuthenticatedCallers = { resolve: () => Promise.resolve(undefined) };

const testBearerPattern = /^Bearer test\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * TEST ONLY (CI fixture): trusts `Authorization: Bearer test.<accountId>` and reads the account's
 * universe. Configuration refuses it unless `NODE_ENV=test` in a `ci` or `local` world, and
 * `selectCallers` refuses it again, so a deployed world can never start with it.
 */
function testBearerCallers(readAccountUniverse: ReadAccountUniverse): AuthenticatedCallers {
  return {
    async resolve(authorization) {
      const match = authorization === undefined ? null : testBearerPattern.exec(authorization);
      if (match?.[1] === undefined) return undefined;
      const account = await readAccountUniverse(match[1]);
      if (account === undefined || account.accountStatus !== 'active' || account.universeStatus !== 'active')
        return undefined;
      return { accountId: account.accountId, universeId: account.universeId, privacyEpoch: account.privacyEpoch };
    },
  };
}

/** Chooses the caller adapter for this process (composition root only). */
export function selectCallers(
  adapter: AuthAdapter,
  release: { readonly nodeEnv: string; readonly world: string },
  readAccountUniverse: ReadAccountUniverse,
): AuthenticatedCallers {
  switch (adapter) {
    case 'none':
      return noCallers;
    case 'test-bearer':
      if (release.nodeEnv !== 'test' || !['ci', 'local'].includes(release.world)) {
        throw new Error('The test-bearer caller adapter is refused outside NODE_ENV=test in a ci or local world');
      }
      return testBearerCallers(readAccountUniverse);
  }
}
