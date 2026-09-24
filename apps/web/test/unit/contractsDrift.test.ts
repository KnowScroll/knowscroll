import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EncounterFeedbackInput,
  EncounterFeedbackReceipt as ContractFeedbackReceipt,
  EvidenceStepWire,
  WhyResponseWire,
} from '../../../../packages/contracts/src/composer.ts';
import {
  encounterFeedbackReceiptSchema,
  feedResponse,
  universe,
  whyResponseSchema,
  worldSystemResponseSchema,
  type EncounterFeedbackReceipt,
  type EncounterFeedbackRequest,
  type EvidenceStep,
  type WhyResponse,
} from '../../src/api/types.ts';
import { encounterFeedbackReceiptOf, feedItem, universeOf, whyOf, worldSystemOf } from './fakeApi.ts';

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

/**
 * #133: `packages/contracts/src/composer.ts` names the "why" response and the feedback receipt as
 * plain TypeScript interfaces only (no zod schema to import), so apps/web writes its strict schemas
 * field-for-field (src/api/types.ts). Two guards keep them from drifting apart: the type-level
 * equalities below fail `pnpm typecheck:web` the moment a field is added, removed or retyped on
 * either side (in either direction -- an extra field the web accepts fails as surely as a missing
 * one), and the strict `.parse()` of each fixture fails at runtime when a fixture and its schema
 * disagree.
 */
describe('composer v3 "why" shapes cannot drift from packages/contracts/src/composer.ts (#133)', () => {
  it('the web schemas have exactly the contract types', () => {
    expectTypeOf<WhyResponse>().toEqualTypeOf<WhyResponseWire>();
    expectTypeOf<EvidenceStep>().toEqualTypeOf<EvidenceStepWire>();
    expectTypeOf<EncounterFeedbackReceipt>().toEqualTypeOf<ContractFeedbackReceipt>();
    expectTypeOf<EncounterFeedbackRequest>().toEqualTypeOf<EncounterFeedbackInput>();
  });

  it('whyOf() strictly satisfies the why schema', () => {
    expect(() => whyResponseSchema.parse(whyOf())).not.toThrow();
  });

  it('encounterFeedbackReceiptOf() strictly satisfies the receipt schema', () => {
    expect(() => encounterFeedbackReceiptSchema.parse(encounterFeedbackReceiptOf())).not.toThrow();
  });
});
