/**
 * #177 — the one owner address every sign-in test signs in as, whatever a local `.env` says.
 *
 * `packages/db/src/index.ts` copies a developer's `.env` into `process.env` (unset keys only) when it
 * is first imported, and a test file's static imports run before its first statement. A default
 * (`??=`) therefore lost to a local `KS_OWNER_EMAIL` in files that import the database statically and
 * won in files that set it before a dynamic import. The files share one disposable database and the
 * single owner account (migration 0016), so the first file created that account under the local
 * address and every later file's magic-link request failed its account insert (HTTP 500).
 */
export const TEST_OWNER_EMAIL = 'owner@knowscroll.test';

/** Pins the owner address for this test process; `resolveOwnerEmail()` reads it on every call. */
export function useTestOwnerEmail(): string {
  process.env.KS_OWNER_EMAIL = TEST_OWNER_EMAIL;
  return TEST_OWNER_EMAIL;
}
