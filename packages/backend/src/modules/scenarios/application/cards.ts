import {
  ScenarioAnswerSchema,
  ScenarioCardSchema,
  type PublicPersonRef,
  type ScenarioAnswer,
  type ScenarioCard,
} from '@knowscroll/contracts';
import { readableAnswerOf } from '../domain/answer-card.js';
import type { NodeAnswer, NodeRow } from './ports.js';

/**
 * A removed branch as a bare placeholder: where it stood in the tree and when it was made, and nothing of what it
 * said. The thread keeps "a branch was removed" in its place, so the tree has no hole, but its title, premises,
 * lens and starter go to no one.
 */
const REMOVED_TITLE = 'Removed';
function removedCardOf(node: NodeRow): ScenarioCard {
  return ScenarioCardSchema.parse({
    nodeId: node.nodeId,
    kind: node.kind,
    origin: 'root',
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    title: REMOVED_TITLE,
    changes: [],
    kept: [],
    hypothetical: node.hypothetical,
    speculative: false,
    assumptions: [],
    status: 'removed',
    revision: node.revision,
    createdAt: node.createdAt.toISOString(),
  });
}

/**
 * The short answer as the thread reads it: a wait, nothing coming, or the checked card without its citations. Only an
 * answer the contract accepts is served (`undefined` otherwise), so a card is never shown that a list could not carry.
 */
export function servableAnswerOf(answer: NodeAnswer): ScenarioAnswer | undefined {
  const candidate =
    answer.state === 'ready'
      ? {
          status: 'ready',
          madeBy: 'knowscroll',
          ...readableAnswerOf(answer.stored),
          readyAt: answer.settledAt.toISOString(),
        }
      : { status: answer.state };
  const parsed = ScenarioAnswerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A stored answer that no longer serves reads as no short answer, never as an error: one row that fails the contract
 * (a limit moved since it was stored) must not make the list throw for every member of the thread.
 */
function answerOf(node: NodeRow): ScenarioAnswer | undefined {
  if (node.answer === undefined) return undefined;
  return servableAnswerOf(node.answer) ?? { status: 'unavailable' };
}

/**
 * A branch as its card in the thread. `startedBy` is the person while they still take part; for
 * anyone else, including a deleted account, it is absent and the card says nothing about who. Nothing
 * here names another member's position, current branch or seen marker. A removed branch is a placeholder.
 */
export function cardOf(node: NodeRow, people: ReadonlyMap<string, PublicPersonRef>): ScenarioCard {
  if (node.status === 'removed') return removedCardOf(node);
  const startedBy = node.startedByAccountId === undefined ? undefined : people.get(node.startedByAccountId);
  return ScenarioCardSchema.parse({
    nodeId: node.nodeId,
    kind: node.kind,
    origin: node.origin.kind,
    ...(node.origin.kind === 'root' ? {} : { originMessageId: node.origin.messageId }),
    ...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
    title: node.title,
    changes: node.changes,
    kept: node.kept,
    ...(node.lens === undefined ? {} : { lens: node.lens }),
    hypothetical: node.hypothetical,
    speculative: node.speculative,
    assumptions: node.assumptions,
    ...(startedBy === undefined ? {} : { startedBy }),
    status: node.status,
    revision: node.revision,
    ...(node.answer === undefined ? {} : { answer: answerOf(node) }),
    ...(node.status === 'ready' && node.assetRevision !== undefined && node.assetTitle !== undefined
      ? {
          content: { kind: 'scroll', assetId: node.assetId, assetRevision: node.assetRevision, title: node.assetTitle },
        }
      : {}),
    createdAt: node.createdAt.toISOString(),
  });
}
