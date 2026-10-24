import { ReadScenarioDraftSchema, ScenarioDraftViewSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { envelope, ok, refuse, type DraftRow, type Result, type ScenarioPorts } from './ports.js';

type View = z.infer<typeof ScenarioDraftViewSchema>;

/**
 * Reads one draft: still thinking, ready with its directions, failed honestly, or already chosen. Only
 * the member who started it can read it, and only while they take part in the thread; anything else
 * is `unavailable` and says nothing about why. Reading changes nothing and commissions nothing.
 */
export function makeReadDraft(p: ScenarioPorts) {
  const summary = (draft: DraftRow) => ({
    draftId: draft.draftId,
    kind: draft.kind,
    text: draft.requestText,
    createdAt: draft.createdAt.toISOString(),
  });

  return async function readDraft(authority: PersonalAuthority, input: unknown): Promise<Result<View>> {
    const parsed = ReadScenarioDraftSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const query = parsed.data;
    const entered = await p.withScope(authority, async (scope): Promise<Result<View>> => {
      const base = { ...envelope(scope), readId: query.readId };
      const unavailable = ok(ScenarioDraftViewSchema.parse({ ...base, status: 'unavailable' }));
      const visit = await p.guest.enter(scope, query.thread, 'read');
      if (!visit) return unavailable;
      const draft = await p.store.readDraft(scope, query.draftId);
      if (
        draft?.threadId !== visit.threadId ||
        draft.requesterAccountId !== visit.self.accountId ||
        draft.expiresAt <= p.now()
      )
        return unavailable;
      switch (draft.state) {
        case 'thinking':
          return ok(ScenarioDraftViewSchema.parse({ ...base, status: 'thinking', draft: summary(draft) }));
        case 'failed':
          return ok(
            ScenarioDraftViewSchema.parse({
              ...base,
              status: 'failed',
              draft: summary(draft),
              reason: draft.failure ?? 'could_not_suggest',
            }),
          );
        case 'chosen':
          return ok(
            draft.nodeId === undefined
              ? ScenarioDraftViewSchema.parse({ ...base, status: 'unavailable' })
              : ScenarioDraftViewSchema.parse({
                  ...base,
                  status: 'chosen',
                  draft: summary(draft),
                  nodeId: draft.nodeId,
                }),
          );
        case 'ready':
          return ok(
            ScenarioDraftViewSchema.parse({
              ...base,
              status: 'ready',
              draft: summary(draft),
              mode: draft.mode,
              options: draft.options,
            }),
          );
      }
    });
    return entered.kind === 'entered' ? entered.value : refuse('unavailable');
  };
}
