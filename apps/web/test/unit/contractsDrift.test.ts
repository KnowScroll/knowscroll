import { describe, expect, it } from 'vitest';
import { feedResponse, universe, worldSystemResponseSchema } from '../../src/api/types.ts';
import { feedItem, universeOf, worldSystemOf } from './fakeApi.ts';

/**
 * #115: the web client's parsing schemas (apps/web/src/api/types.ts) and its hand-written unit
 * test fixtures (fakeApi.ts) both now derive from the one shared definition in
 * packages/contracts/src/web-bootstrap.ts, instead of being two independently hand-maintained
 * literals that can silently disagree with each other -- and with the server -- the way
 * apps/web's `universe` schema and `universeOf()` fixture both disagreed with ADR-0030's
 * `recordingPausedAt` addition in #120.
 *
 * These are strict `.parse()` calls (not `.safeParse()`), so this test throws -- not merely
 * fails an assertion -- the moment a fixture and its schema stop matching exactly: a field the
 * schema requires and the fixture omits, or a field the fixture sends that the schema no longer
 * declares. That is deliberate: it is the runtime half of the protection TypeScript already gives
 * at compile time via each `*Of()` fixture's own `: Universe`/`: WorldSystemResponse` return-type
 * annotation (a missing or excess property on a literal fails `pnpm typecheck:web` before this
 * test ever runs). See the PR/commit description for the RED-then-GREEN demonstration: a field
 * temporarily added to packages/contracts/src/web-bootstrap.ts's `universeSchema` alone fails both
 * `pnpm typecheck:web` (fakeApi.ts's `universeOf()` literal) and this test, then passes again once
 * `universeOf()` supplies it (or the field is reverted).
 */
describe('web bootstrap fixtures cannot drift from packages/contracts/src/web-bootstrap.ts', () => {
  it('universeOf() strictly satisfies the shared universe schema', () => {
    expect(() => universe.parse(universeOf())).not.toThrow();
  });

  it('worldSystemOf() strictly satisfies the shared worlds schema', () => {
    expect(() => worldSystemResponseSchema.parse(worldSystemOf())).not.toThrow();
  });

  it('a feed response built from feedItem() strictly satisfies the shared feed schema', () => {
    const response = {
      decisionId: 'd1',
      universeId: universeOf().universeId,
      accountRevision: 1,
      privacyEpoch: 0,
      items: [feedItem()],
    };
    expect(() => feedResponse.parse(response)).not.toThrow();
  });
});
