import { ScenarioDraftStartedSchema, StartScenarioDraftSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import type { ThreadVisit } from '../../social/public.js';
import { parentFactsOf } from './parent.js';
import { envelope, ok, refuse, type Origin, type Result, type ScenarioPorts } from './ports.js';

/** How long a draft lives, and how many a member may start per UTC day. */
export const DRAFT_LIFETIME_MS = 2 * 60 * 60_000;
export const DRAFTS_PER_DAY = 20;
const UTC_DAY_MS = 86_400_000;

type StartInput = z.infer<typeof StartScenarioDraftSchema>;

/**
 * Starts a draft: stores the member's request and sends one bounded model step to a worker. It
 * commissions nothing (D-006 i), so opening the sheet, asking for ideas or an unsolicited
 * suggestion never costs a production. A retry with the same command returns the same draft.
 *
 * Authority: the caller's membership reference, rechecked under the thread's lock with their
 * account gate (lock order: personal root, account gate, thread). Refused without a receipt: a
 * request whose origin message is not in this thread or has no words, a parent the caller saw at
 * another revision (`stale_revision`), a thread nothing of which can be researched by code
 * (`unsupported`), and a member past their day's drafts (`budget_unavailable`).
 */
export function makeStartDraft(p: ScenarioPorts) {
  return async function startDraft(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ScenarioDraftStartedSchema>>> {
    const parsed = StartScenarioDraftSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const entered = await p.withScope(
      authority,
      async (scope): Promise<Result<z.infer<typeof ScenarioDraftStartedSchema>>> => {
        const visit = await p.guest.enter(scope, command.thread, 'write');
        if (!visit) return refuse('unavailable');
        const key = {
          commandId: command.commandId,
          operation: 'scenarios.draft',
          outcomeVersion: 1,
          requestHash: p.hash('scenarios.draft', { ...command, actorPrivacyEpoch: scope.authority.privacyEpoch }),
        };
        const receipt = await p.guest.receipts.find(visit, key);
        if (receipt.kind === 'refused') return refuse('command_key_reused');
        if (receipt.kind === 'replay')
          return ok({ ...ScenarioDraftStartedSchema.parse(receipt.outcome), replayed: true });

        const parent = await parentFactsOf(p, scope, visit, command.parent);
        if (parent.kind === 'stale') return refuse('stale_revision');
        if (parent.kind === 'missing') return refuse('unavailable');
        const origin = await originOf(p, visit, command.origin);
        if (origin === undefined) return refuse('invalid_input');
        if ((await p.readSourcePages(scope, visit.root)).length === 0) return refuse('unsupported');

        const now = p.now();
        const startOfDay = new Date(Math.floor(now.getTime() / UTC_DAY_MS) * UTC_DAY_MS);
        await p.store.pruneDrafts(scope, visit.self.accountId, visit.threadId, now);
        if ((await p.store.countDraftsStartedSince(scope, visit.self.accountId, startOfDay)) >= DRAFTS_PER_DAY)
          return refuse('budget_unavailable');

        const draftId = p.stableId('scenario-draft', visit.self.accountId, command.commandId);
        await p.guest.receipts.begin(visit, key);
        await p.store.insertDraft(scope, {
          draftId,
          threadId: visit.threadId,
          requesterAccountId: visit.self.accountId,
          requesterUniverseId: visit.self.universeId,
          privacyEpoch: visit.self.privacyEpoch,
          kind: command.kind,
          origin,
          ...(parent.nodeId === undefined ? {} : { parentNodeId: parent.nodeId }),
          parentRevision: command.parent.kind === 'root' ? command.parent.assetRevision : command.parent.revision,
          requestText: command.text,
          createdAt: now,
          expiresAt: new Date(now.getTime() + DRAFT_LIFETIME_MS),
        });
        await p.enqueueSuggest(scope, { draftId });
        const acceptance = ScenarioDraftStartedSchema.parse({
          ...envelope(scope),
          commandId: command.commandId,
          recordedAt: now.toISOString(),
          replayed: false,
          outcome: 'accepted',
          operation: 'scenario.draft',
          draftId,
        });
        await p.guest.receipts.complete(visit, key, acceptance);
        return ok(acceptance);
      },
    );
    return entered.kind === 'entered' ? entered.value : refuse('unavailable');
  };
}

/**
 * Where the request came from. A message must belong to this thread and have words (a tombstone has
 * none); whether it is a snippet is the thread's fact, not the client's.
 */
async function originOf(
  p: ScenarioPorts,
  visit: ThreadVisit,
  origin: StartInput['origin'],
): Promise<Origin | undefined> {
  if (origin.kind === 'root') return { kind: 'root' };
  const window = await p.guest.window(visit, { limit: 1, originMessageId: origin.messageId });
  if (window.origin === undefined) return undefined;
  return { kind: window.origin.snippet === undefined ? 'message' : 'snippet', messageId: origin.messageId };
}
