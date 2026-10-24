import { ChooseScenarioSchema, ScenarioChoiceAcceptanceSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { ThreadVisit } from '../../social/public.js';
import { framingOf, kickerOf, writerBrief } from '../domain/brief.js';
import { meaningOf, planStep, type Step, type StepRequest } from '../domain/exploration.js';
import { cardOf } from './cards.js';
import { parentFactsOf } from './parent.js';
import { envelope, ok, refuse, type DraftRow, type NodeRow, type Result, type ScenarioPorts } from './ports.js';

type Choice = z.infer<typeof ChooseScenarioSchema>;
type Acceptance = z.infer<typeof ScenarioChoiceAcceptanceSchema>;

const TITLE_CHARS = 120;

/** A card title for a request the member wrote themselves: the idea in its own statement, never their raw words. */
function titleOf(step: Step): string {
  const text = step.kind === 'what_if' ? (step.changes[0]?.statement ?? '') : (step.lens ?? '');
  return text.length <= TITLE_CHARS ? text : `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/** The request a choice stands for, with the direction's own title and explanation when it was one of the draft's. */
interface Chosen {
  readonly request: StepRequest;
  readonly title?: string;
  readonly explanation?: string;
}

/** Everything one new branch is made from. */
interface NewBranch {
  readonly scope: PersonalScopeTx;
  readonly visit: ThreadVisit;
  readonly draft: DraftRow;
  readonly chosen: Chosen;
  readonly step: Step;
  readonly parent: { readonly nodeId?: string; readonly title?: string };
  readonly semanticKey: string;
  readonly commandId: string;
}

/** The step the member chose: one of the draft's stored directions by ID, or their own complete request. */
function requestOf(draft: DraftRow, selection: Choice['selection']): Chosen | undefined {
  if (selection.kind === 'own')
    return { request: { kind: draft.kind, changes: selection.changes, kept: selection.kept, lens: selection.lens } };
  const option = draft.options?.find((candidate) => candidate.optionId === selection.optionId);
  if (draft.state !== 'ready' || option === undefined) return undefined;
  return {
    request: {
      kind: draft.kind,
      changes: option.changes,
      kept: option.kept,
      lens: option.lens,
      speculative: option.needsConfirmation,
    },
    title: option.title,
    explanation: option.explanation,
  };
}

/**
 * Chooses a direction, or submits a complete request: the only command that commissions content
 * (D-006 i; blueprint §14). A choice makes the branch's node, orders its Scroll from Quartermaster and
 * sends the production job, all in one transaction with the receipt, so a retry is the same branch and
 * a rollback leaves nothing. If the thread already has this very branch (another member asked for the
 * same change), no second one is made and the draft points at the existing branch.
 *
 * Authority: the caller's membership reference under the thread's lock; the draft must be theirs,
 * unchosen and unexpired; the parent must be at the revision they saw. Refused without a receipt: a
 * choice the step rules refuse (`invalid_input`), a stale parent (`stale_revision`), a thread
 * nothing of which can be researched by code (`unsupported`) and a cap (`budget_unavailable`).
 * Lock order: personal root, account gate, thread, draft and node rows, then Quartermaster's
 * commissioning lock. No model call or network wait happens here.
 */
export function makeChoose(p: ScenarioPorts) {
  async function newBranch(input: NewBranch): Promise<Result<NodeRow>> {
    const { scope, visit, draft, chosen, step, parent, semanticKey, commandId } = input;
    const [subject] = await p.readContent(scope, [visit.root]);
    if (subject?.status !== 'available') return refuse('unavailable');
    const pages = await p.readSourcePages(scope, visit.root);
    if (pages.length === 0) return refuse('unsupported');
    const nodeId = p.stableId('scenario-node', visit.self.accountId, commandId);
    const assetId = p.stableId('scenario-asset', nodeId);
    const title = chosen.title ?? titleOf(step);
    const order = await p.commission(scope, {
      threadId: visit.threadId,
      order: {
        orderId: nodeId,
        assetId,
        mode: step.kind,
        brief: writerBrief({
          step,
          title,
          explanation: chosen.explanation,
          subjectTitle: subject.metadata.title,
          subjectSummary: subject.metadata.summary,
          parentTitle: parent.title,
        }),
        pages,
        kicker: kickerOf(step),
        framing: framingOf(step),
      },
    });
    if (order.kind === 'refused') return refuse('budget_unavailable');
    const node = {
      nodeId,
      threadId: visit.threadId,
      ...(parent.nodeId === undefined ? {} : { parentNodeId: parent.nodeId }),
      kind: step.kind,
      origin: draft.origin,
      startedByAccountId: visit.self.accountId,
      title,
      ...(step.lens === undefined ? {} : { lens: step.lens }),
      changes: step.changes,
      kept: step.kept,
      assumptions: step.assumptions,
      hypothetical: step.hypothetical,
      speculative: step.speculative,
      semanticKey,
      assetId,
      createdAt: p.now(),
    };
    await p.store.insertNode(scope, node);
    await p.store.chooseDraft(scope, draft.draftId, nodeId);
    return ok({ ...node, status: 'preparing', revision: 1 });
  }

  return async function choose(authority: PersonalAuthority, input: unknown): Promise<Result<Acceptance>> {
    const parsed = ChooseScenarioSchema.safeParse(input);
    if (!parsed.success) return refuse('invalid_input');
    const command = parsed.data;
    const entered = await p.withScope(authority, async (scope): Promise<Result<Acceptance>> => {
      const visit = await p.guest.enter(scope, command.thread, 'write');
      if (!visit) return refuse('unavailable');
      const key = {
        commandId: command.commandId,
        operation: 'scenarios.choose',
        outcomeVersion: 1,
        requestHash: p.hash('scenarios.choose', { ...command, actorPrivacyEpoch: scope.authority.privacyEpoch }),
      };
      const people = new Map(visit.participants.map((participant) => [participant.accountId, participant.person]));
      const receipt = await p.guest.receipts.find(visit, key);
      if (receipt.kind === 'refused') return refuse('command_key_reused');
      if (receipt.kind === 'replay') {
        // The first answer's branch as it stands now: preparing may have become ready since.
        const first = ScenarioChoiceAcceptanceSchema.parse(receipt.outcome);
        const current = await p.store.readNode(scope, first.node.nodeId);
        return ok({
          ...first,
          replayed: true,
          node: current === undefined ? first.node : cardOf(current, people),
        });
      }

      const draft = await p.store.lockDraft(scope, command.draftId);
      if (
        draft?.threadId !== visit.threadId ||
        draft.requesterAccountId !== visit.self.accountId ||
        draft.state === 'chosen' ||
        draft.expiresAt <= p.now()
      )
        return refuse('unavailable');
      const parent = await parentFactsOf(
        p,
        scope,
        visit,
        draft.parentNodeId === undefined
          ? { kind: 'root', assetRevision: draft.parentRevision }
          : { kind: 'node', nodeId: draft.parentNodeId, revision: draft.parentRevision },
      );
      if (parent.kind === 'stale') return refuse('stale_revision');
      if (parent.kind === 'missing') return refuse('unavailable');
      const chosen = requestOf(draft, command.selection);
      if (chosen === undefined) return refuse('invalid_input');
      const planned = planStep(parent.facts, chosen.request);
      if (!planned.ok) return refuse('invalid_input');

      const semanticKey = p.hash('scenarios.meaning', meaningOf(parent.nodeId ?? null, planned.step));
      const existing = await p.store.findLiveByMeaning(scope, visit.threadId, semanticKey);
      let node: NodeRow;
      if (existing !== undefined) {
        await p.store.chooseDraft(scope, draft.draftId, existing.nodeId);
        node = existing;
      } else {
        const made = await newBranch({
          scope,
          visit,
          draft,
          chosen,
          step: planned.step,
          parent,
          semanticKey,
          commandId: command.commandId,
        });
        if (made.kind === 'refused') return made;
        node = made.value;
      }

      await p.guest.receipts.begin(visit, key);
      if (existing === undefined) await p.guest.announce(visit);
      const acceptance = ScenarioChoiceAcceptanceSchema.parse({
        ...envelope(scope),
        commandId: command.commandId,
        recordedAt: p.now().toISOString(),
        replayed: false,
        outcome: 'accepted',
        operation: 'scenario.choose',
        node: cardOf(node, people),
        reused: existing !== undefined,
      });
      await p.guest.receipts.complete(visit, key, acceptance);
      return ok(acceptance);
    });
    return entered.kind === 'entered' ? entered.value : refuse('unavailable');
  };
}
