import type { ComposerSnapshot } from '@knowscroll/backend/modules/composer';
import type { PersonalAuthority } from '@knowscroll/backend/modules/identity';
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
