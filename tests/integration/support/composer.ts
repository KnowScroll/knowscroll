import { randomUUID } from 'node:crypto';
import { composeEncounter, type ComposerSnapshot } from '@knowscroll/backend/modules/composer';
import {
  composerBufferStore,
  jevPoolStore,
  makeComposerStore,
} from '@knowscroll/backend/modules/composer/nest-providers';
import type { PersonalAuthority, WithPersonalScope } from '@knowscroll/backend/modules/identity';
/** Labelled CI fixture: no history, no activity, no claimed provider output. */
export function fixtureComposerSnapshot(authority: PersonalAuthority): ComposerSnapshot {
  return {
    universeId: authority.universeId,
    privacyEpoch: authority.privacyEpoch,
    evaluatedAt: '2026-10-20T12:00:00Z',
    seed: 'ci-fixture',
    mode: 'vertical',
    intent: { language: 'en', topicIds: [], text: '' },
    candidates: [],
    explorationPool: [],
    watermarks: {
      catalog: 'ci-fixture',
      continuity: 'ci-fixture',
      taxonomy: 'ci-fixture',
      context: 'ci-no-prepared-context',
    },
  };
}

/**
 * Labelled CI fixture: a decision, a buffer row and a stored Jev assessment for erasure coverage
 * tests. They point at made-up content; nothing here is a ranking or a model answer about real content.
 */
export async function seedComposerBuffer(withScope: WithPersonalScope, authority: PersonalAuthority): Promise<void> {
  const decisionId = randomUUID();
  const entered = await withScope(authority, async (scope) => {
    await makeComposerStore({ isOperator: () => true }).persistComposerDecision(
      scope,
      { decisionId, commandId: randomUUID() },
      composeEncounter(fixtureComposerSnapshot(authority)),
    );
    await composerBufferStore.store(scope, {
      key: { sessionId: randomUUID(), intentRevision: 0, source: { offerId: randomUUID(), exposureId: randomUUID() } },
      decisionId,
      selection: [{ assetId: randomUUID(), assetRevision: 1, catalogWatermark: 'ci-fixture' }],
      preparedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await jevPoolStore.store(
      scope,
      {
        roleVersion: 'ci-fixture',
        model: 'ci-fixture',
        entries: [
          {
            subject: 'en|topic:ci-fixture',
            assetId: randomUUID(),
            assetRevision: 1,
            relevance: 0.5,
            appropriateness: 0.5,
            redundancy: 0.5,
            assessedAt: new Date().toISOString(),
          },
        ],
      },
      new Date(),
    );
  });
  if (entered.kind !== 'entered') throw new Error('CI fixture scope refused');
}
