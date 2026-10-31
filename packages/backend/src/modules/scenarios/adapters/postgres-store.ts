import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import { AssumptionSchema, OptionChangeSchema } from '@knowscroll/contracts';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readerOn, transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { BranchPoolStore, DraftRow, NodeAnswer, NodeRow, Origin, ScenarioStore } from '../application/ports.js';
import { StoredAnswerSchema } from '../application/answer-schemas.js';

const Assumptions = z.array(AssumptionSchema);
/**
 * A direction as a draft stores it. A draft stored before directions carried their own `speculative` flag has none:
 * what it called "needs confirmation" is what the branch made from it was then marked with, so that is its flag.
 */
const StoredOptions = z.array(
  z
    .strictObject({
      optionId: z.enum(['o1', 'o2', 'o3']),
      title: z.string(),
      explanation: z.string(),
      changes: z.array(OptionChangeSchema),
      kept: Assumptions,
      lens: z.string().optional(),
      speculative: z.boolean().optional(),
      needsConfirmation: z.boolean(),
    })
    .transform((option) => ({ ...option, speculative: option.speculative ?? option.needsConfirmation })),
);

type DraftColumns = Selectable<Database['scenarios.drafts']>;
type NodeColumns = Selectable<Database['scenarios.nodes']>;

const originOf = (kind: string, messageId: string | null): Origin =>
  kind === 'root' || messageId === null
    ? { kind: 'root' }
    : { kind: kind === 'snippet' ? 'snippet' : 'message', messageId };

const draftOf = (row: DraftColumns): DraftRow => ({
  draftId: row.draft_id,
  threadId: row.thread_id,
  requesterAccountId: row.requester_account_id,
  requesterUniverseId: row.requester_universe_id,
  privacyEpoch: row.privacy_epoch,
  kind: row.kind === 'perspective' ? 'perspective' : 'what_if',
  origin: originOf(row.origin_kind, row.origin_message_id),
  ...(row.parent_node_id === null ? {} : { parentNodeId: row.parent_node_id }),
  parentRevision: row.parent_revision,
  requestText: row.request_text,
  state: row.state as DraftRow['state'],
  ...(row.failure === null ? {} : { failure: row.failure as NonNullable<DraftRow['failure']> }),
  ...(row.mode === null ? {} : { mode: row.mode as NonNullable<DraftRow['mode']> }),
  ...(row.options === null ? {} : { options: StoredOptions.parse(row.options) }),
  ...(row.node_id === null ? {} : { nodeId: row.node_id }),
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
});

/** The short answer a row holds: absent unless the branch has one, and a ready one is read back through its own schema. */
function answerOf(row: NodeColumns): NodeAnswer | undefined {
  if (row.answer_state === 'making') return { state: 'making' };
  if (row.answer_state === 'unavailable' && row.answer_settled_at !== null)
    return { state: 'unavailable', settledAt: new Date(row.answer_settled_at) };
  if (row.answer_state === 'ready' && row.answer_settled_at !== null) {
    // A stored card that no longer reads (a limit moved since) is no short answer, not an error for the whole thread.
    const stored = StoredAnswerSchema.safeParse(row.answer);
    const settledAt = new Date(row.answer_settled_at);
    return stored.success ? { state: 'ready', settledAt, stored: stored.data } : { state: 'unavailable', settledAt };
  }
  return undefined;
}

function nodeOf(row: NodeColumns): NodeRow {
  const answer = answerOf(row);
  return {
    nodeId: row.node_id,
    threadId: row.thread_id,
    ...(row.parent_node_id === null ? {} : { parentNodeId: row.parent_node_id }),
    kind: row.kind === 'perspective' ? 'perspective' : 'what_if',
    origin: originOf(row.origin_kind, row.origin_message_id),
    ...(row.started_by_account_id === null ? {} : { startedByAccountId: row.started_by_account_id }),
    title: row.title,
    ...(row.lens === null ? {} : { lens: row.lens }),
    changes: Assumptions.parse(row.changes),
    kept: Assumptions.parse(row.kept),
    assumptions: Assumptions.parse(row.assumptions),
    hypothetical: row.hypothetical,
    speculative: row.speculative,
    semanticKey: row.semantic_key,
    status: row.status as NodeRow['status'],
    revision: row.revision,
    assetId: row.asset_id,
    ...(row.asset_revision === null ? {} : { assetRevision: row.asset_revision }),
    ...(row.asset_title === null ? {} : { assetTitle: row.asset_title }),
    ...(answer === undefined ? {} : { answer }),
    createdAt: new Date(row.created_at),
  };
}

/** Drafts a member keeps in one thread besides the newest: older unchosen ones are deleted when they start another. */
const DRAFTS_KEPT_PER_THREAD = 2;

/** Scenario rows inside a personal scope (migration for schema `scenarios`). The use cases decide access; this only runs queries. */
export const scenarioStore: ScenarioStore = {
  async insertDraft(scope, draft) {
    await transactionOf(scope)
      .insertInto('scenarios.drafts')
      .values({
        draft_id: draft.draftId,
        thread_id: draft.threadId,
        requester_account_id: draft.requesterAccountId,
        requester_universe_id: draft.requesterUniverseId,
        privacy_epoch: draft.privacyEpoch,
        kind: draft.kind,
        origin_kind: draft.origin.kind,
        origin_message_id: draft.origin.kind === 'root' ? null : draft.origin.messageId,
        parent_node_id: draft.parentNodeId ?? null,
        parent_revision: draft.parentRevision,
        request_text: draft.requestText,
        state: 'thinking',
        created_at: draft.createdAt,
        expires_at: draft.expiresAt,
      })
      .execute();
  },

  async readDraft(scope, draftId) {
    const row = await transactionOf(scope)
      .selectFrom('scenarios.drafts')
      .selectAll()
      .where('draft_id', '=', draftId)
      .executeTakeFirst();
    return row && draftOf(row);
  },

  async lockDraft(scope, draftId) {
    const row = await transactionOf(scope)
      .selectFrom('scenarios.drafts')
      .selectAll()
      .where('draft_id', '=', draftId)
      .forUpdate()
      .executeTakeFirst();
    return row && draftOf(row);
  },

  async finishDraft(scope, draftId, outcome) {
    const changed = await transactionOf(scope)
      .updateTable('scenarios.drafts')
      .set(
        outcome.kind === 'ready'
          ? { state: 'ready', mode: outcome.mode, options: JSON.stringify(outcome.options) }
          : { state: 'failed', failure: outcome.failure },
      )
      .where('draft_id', '=', draftId)
      .where('state', '=', 'thinking')
      .executeTakeFirst();
    return changed.numUpdatedRows === 1n;
  },

  async chooseDraft(scope, draftId, nodeId) {
    await transactionOf(scope)
      .updateTable('scenarios.drafts')
      .set({ state: 'chosen', node_id: nodeId })
      .where('draft_id', '=', draftId)
      .execute();
  },

  async deleteDraft(scope, draftId) {
    await transactionOf(scope).deleteFrom('scenarios.drafts').where('draft_id', '=', draftId).execute();
  },

  async pruneDrafts(scope, accountId, threadId, now) {
    const trx = transactionOf(scope);
    await trx
      .deleteFrom('scenarios.drafts')
      .where('requester_account_id', '=', accountId)
      .where('expires_at', '<=', now)
      .where('state', '<>', 'chosen')
      .execute();
    // A draft that points at a node is the node's origin record; only unchosen ones are pruned.
    await sql`delete from scenarios.drafts where draft_id in (
      select draft_id from scenarios.drafts
      where requester_account_id = ${accountId}::uuid and thread_id = ${threadId}::uuid and state <> 'chosen'
      order by created_at desc, draft_id offset ${DRAFTS_KEPT_PER_THREAD})`.execute(trx);
  },

  async countDraftsStartedSince(scope, accountId, since) {
    const row = await transactionOf(scope)
      .selectFrom('receipts.shared_commands')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('actor_account_id', '=', accountId)
      .where('operation', '=', 'scenarios.draft')
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  },

  async insertNode(scope, node) {
    await transactionOf(scope)
      .insertInto('scenarios.nodes')
      .values({
        node_id: node.nodeId,
        thread_id: node.threadId,
        parent_node_id: node.parentNodeId ?? null,
        kind: node.kind,
        origin_kind: node.origin.kind,
        origin_message_id: node.origin.kind === 'root' ? null : node.origin.messageId,
        started_by_account_id: node.startedByAccountId ?? null,
        title: node.title,
        lens: node.lens ?? null,
        changes: JSON.stringify(node.changes),
        kept: JSON.stringify(node.kept),
        assumptions: JSON.stringify(node.assumptions),
        hypothetical: node.hypothetical,
        speculative: node.speculative,
        semantic_key: node.semanticKey,
        status: 'preparing',
        revision: 1,
        asset_id: node.assetId,
        answer_state: node.answerMaking ? 'making' : null,
        created_at: node.createdAt,
        updated_at: node.createdAt,
      })
      .execute();
  },

  async readNode(scope, nodeId) {
    const row = await transactionOf(scope)
      .selectFrom('scenarios.nodes')
      .selectAll()
      .where('node_id', '=', nodeId)
      .executeTakeFirst();
    return row && nodeOf(row);
  },

  async lockNode(scope, nodeId) {
    const row = await transactionOf(scope)
      .selectFrom('scenarios.nodes')
      .selectAll()
      .where('node_id', '=', nodeId)
      .forUpdate()
      .executeTakeFirst();
    return row && nodeOf(row);
  },

  async listNodes(scope, threadId) {
    const rows = await transactionOf(scope)
      .selectFrom('scenarios.nodes')
      .selectAll()
      .where('thread_id', '=', threadId)
      .orderBy('created_at')
      .orderBy('node_id')
      .execute();
    return rows.map(nodeOf);
  },

  async listOpenDrafts(scope, accountId, threadId, now) {
    const rows = await transactionOf(scope)
      .selectFrom('scenarios.drafts')
      .selectAll()
      .where('requester_account_id', '=', accountId)
      .where('thread_id', '=', threadId)
      .where('state', '=', 'ready')
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('draft_id')
      .execute();
    return rows.map(draftOf);
  },

  async findLiveByMeaning(scope, threadId, semanticKey) {
    const row = await transactionOf(scope)
      .selectFrom('scenarios.nodes')
      .selectAll()
      .where('thread_id', '=', threadId)
      .where('semantic_key', '=', semanticKey)
      .where('status', 'in', ['preparing', 'ready'])
      .executeTakeFirst();
    return row && nodeOf(row);
  },

  async removeNode(scope, nodeId) {
    const row = await transactionOf(scope)
      .updateTable('scenarios.nodes')
      .set({
        status: 'removed',
        revision: sql`revision + 1`,
        updated_at: new Date(),
        answer_state: null,
        answer: null,
        answer_settled_at: null,
      })
      .where('node_id', '=', nodeId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return nodeOf(row);
  },

  async finishAnswer(scope, nodeId, settlement, now) {
    const changed = await transactionOf(scope)
      .updateTable('scenarios.nodes')
      .set(
        settlement.kind === 'ready'
          ? { answer_state: 'ready', answer: JSON.stringify(settlement.stored), answer_settled_at: now }
          : { answer_state: 'unavailable', answer: null, answer_settled_at: now },
      )
      .where('node_id', '=', nodeId)
      .where('answer_state', '=', 'making')
      .where('status', '<>', 'removed')
      .executeTakeFirst();
    return changed.numUpdatedRows === 1n;
  },
};

/** Reads and writes outside a personal scope: the resolver's and the audience check's. */
export function branchPoolStore(db: Kysely<Database>): BranchPoolStore {
  return {
    async preparing(limit) {
      const rows = await db
        .selectFrom('scenarios.nodes')
        .select(['node_id', 'thread_id', 'created_at'])
        .where('status', '=', 'preparing')
        .orderBy('created_at')
        .orderBy('node_id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ nodeId: row.node_id, threadId: row.thread_id, createdAt: new Date(row.created_at) }));
    },

    async settle(nodeId, settlement, now) {
      return withTransaction(db, 'scenarios.settle-branch', async (trx) => {
        // A branch another transaction holds (a removal, a restart of this sweep) is left for the next sweep.
        const row = await trx
          .selectFrom('scenarios.nodes')
          .select(['thread_id'])
          .where('node_id', '=', nodeId)
          .where('status', '=', 'preparing')
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (row === undefined) return undefined;
        await trx
          .updateTable('scenarios.nodes')
          .set(
            settlement.kind === 'ready'
              ? { status: 'ready', asset_revision: settlement.assetRevision, asset_title: settlement.assetTitle }
              : { status: 'failed' },
          )
          .set({ revision: sql`revision + 1`, updated_at: now })
          .where('node_id', '=', nodeId)
          .execute();
        return { threadId: row.thread_id };
      });
    },

    async answersMaking(limit) {
      const rows = await db
        .selectFrom('scenarios.nodes')
        .select(['node_id', 'thread_id', 'created_at'])
        .where('answer_state', '=', 'making')
        .orderBy('created_at')
        .orderBy('node_id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({ nodeId: row.node_id, threadId: row.thread_id, createdAt: new Date(row.created_at) }));
    },

    async settleAnswerUnavailable(nodeId, now) {
      return withTransaction(db, 'scenarios.settle-answer', async (trx) => {
        // A branch another transaction holds (the worker storing its answer, a removal) is left for the next sweep.
        const row = await trx
          .selectFrom('scenarios.nodes')
          .select(['thread_id'])
          .where('node_id', '=', nodeId)
          .where('answer_state', '=', 'making')
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (row === undefined) return undefined;
        await trx
          .updateTable('scenarios.nodes')
          .set({ answer_state: 'unavailable', answer: null, answer_settled_at: now })
          .where('node_id', '=', nodeId)
          .execute();
        return { threadId: row.thread_id };
      });
    },

    async holdersOfAssets(on, assetIds) {
      if (assetIds.length === 0) return new Map();
      const rows = await readerOn(db, on)
        .selectFrom('scenarios.nodes')
        .select(['asset_id', 'thread_id', 'status'])
        .where('asset_id', 'in', [...assetIds])
        .execute();
      return new Map(
        rows.flatMap((row) =>
          row.asset_id === null
            ? []
            : [[row.asset_id, { threadId: row.thread_id, status: row.status as NodeRow['status'] }] as const],
        ),
      );
    },
  };
}
