import type { PersonalAuthority, PersonalScopeTx, ReadOn, WithPersonalScope } from '../../identity/public.js';
import type { ReadScrollSourcePages, ReadShareableContent } from '../../content/public.js';
import type { ReadVisitedAssets } from '../../experience/public.js';
import type { CommissionScenarioOrder } from '../../supply/public.js';
import type { ThreadGuest } from '../../social/public.js';
import type { Assumption, StepChange } from '../domain/assumptions.js';
import type { ScenarioKind } from '../domain/exploration.js';

export type Origin = { readonly kind: 'root' } | { readonly kind: 'snippet' | 'message'; readonly messageId: string };

/** A direction the Scenario Planner proposed, as the draft stores it. */
export interface StoredOption {
  readonly optionId: 'o1' | 'o2' | 'o3';
  readonly title: string;
  readonly explanation: string;
  readonly changes: readonly StepChange[];
  readonly kept: readonly Assumption[];
  readonly lens?: string;
  /** The premise contradicts established knowledge. An edit of this direction keeps the flag. */
  readonly speculative: boolean;
  /** The idea is unclear or speculative: the member confirms it before anything is made. */
  readonly needsConfirmation: boolean;
}

export type DraftState = 'thinking' | 'ready' | 'failed' | 'chosen';
export type DraftFailure = 'could_not_suggest' | 'budget_unavailable';

/** One member's composer session: their words, where they came from and what the planner proposed. */
export interface DraftRow {
  readonly draftId: string;
  readonly threadId: string;
  readonly requesterAccountId: string;
  readonly requesterUniverseId: string;
  readonly privacyEpoch: number;
  readonly kind: ScenarioKind;
  readonly origin: Origin;
  readonly parentNodeId?: string;
  readonly parentRevision: number;
  readonly requestText: string;
  readonly state: DraftState;
  readonly failure?: DraftFailure;
  readonly mode?: 'direct' | 'options';
  readonly options?: readonly StoredOption[];
  readonly nodeId?: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type NewDraft = Omit<DraftRow, 'state' | 'failure' | 'mode' | 'options' | 'nodeId'>;

export type NodeStatus = 'preparing' | 'ready' | 'failed' | 'removed';

/** A branch of the thread: one node of its exploration graph. */
export interface NodeRow {
  readonly nodeId: string;
  readonly threadId: string;
  readonly parentNodeId?: string;
  readonly kind: ScenarioKind;
  readonly origin: Origin;
  /** Absent once the starter's account was deleted. */
  readonly startedByAccountId?: string;
  readonly title: string;
  readonly lens?: string;
  readonly changes: readonly Assumption[];
  readonly kept: readonly Assumption[];
  readonly assumptions: readonly Assumption[];
  readonly hypothetical: boolean;
  /** Flagged speculative by the Planner and confirmed, or below a branch that was. */
  readonly speculative: boolean;
  readonly semanticKey: string;
  readonly status: NodeStatus;
  readonly revision: number;
  readonly assetId: string;
  readonly assetRevision?: number;
  readonly assetTitle?: string;
  readonly createdAt: Date;
}

export type NewNode = Omit<NodeRow, 'status' | 'revision' | 'assetRevision' | 'assetTitle'>;

/** What the resolver does with a preparing branch. */
export type Settlement =
  { readonly kind: 'ready'; readonly assetRevision: number; readonly assetTitle: string } | { readonly kind: 'failed' };

/** Scenario rows inside a personal scope (HTTP commands and the draft worker). Each method is one query or write; none decides access. */
export interface ScenarioStore {
  insertDraft(scope: PersonalScopeTx, draft: NewDraft): Promise<void>;
  readDraft(scope: PersonalScopeTx, draftId: string): Promise<DraftRow | undefined>;
  /** FOR UPDATE: the choice and the planner's answer cannot interleave. */
  lockDraft(scope: PersonalScopeTx, draftId: string): Promise<DraftRow | undefined>;
  /** Stores the planner's outcome while the draft is still `thinking`; false when it no longer is. */
  finishDraft(
    scope: PersonalScopeTx,
    draftId: string,
    outcome:
      | { readonly kind: 'ready'; readonly mode: 'direct' | 'options'; readonly options: readonly StoredOption[] }
      | { readonly kind: 'failed'; readonly failure: DraftFailure },
  ): Promise<boolean>;
  chooseDraft(scope: PersonalScopeTx, draftId: string, nodeId: string): Promise<void>;
  deleteDraft(scope: PersonalScopeTx, draftId: string): Promise<void>;
  /** Deletes this member's expired drafts, and their unchosen ones beyond the newest two, in this thread. */
  pruneDrafts(scope: PersonalScopeTx, accountId: string, threadId: string, now: Date): Promise<void>;
  /**
   * How many drafts this member started since `since`, counted from their accepted commands rather
   * than from rows, so deleting old drafts never gives the day back.
   */
  countDraftsStartedSince(scope: PersonalScopeTx, accountId: string, since: Date): Promise<number>;
  insertNode(scope: PersonalScopeTx, node: NewNode): Promise<void>;
  readNode(scope: PersonalScopeTx, nodeId: string): Promise<NodeRow | undefined>;
  /** FOR UPDATE. */
  lockNode(scope: PersonalScopeTx, nodeId: string): Promise<NodeRow | undefined>;
  listNodes(scope: PersonalScopeTx, threadId: string): Promise<readonly NodeRow[]>;
  /** This member's ready, unexpired, unchosen drafts in the thread, newest first: the directions they have not made. */
  listOpenDrafts(scope: PersonalScopeTx, accountId: string, threadId: string, now: Date): Promise<readonly DraftRow[]>;
  findLiveByMeaning(scope: PersonalScopeTx, threadId: string, semanticKey: string): Promise<NodeRow | undefined>;
  /** Sets `removed` and moves the revision. */
  removeNode(scope: PersonalScopeTx, nodeId: string): Promise<NodeRow>;
}

/** Reads and writes that need no personal scope: the resolver's, and the audience check. Each write is its own short transaction. */
export interface BranchPoolStore {
  /** Preparing branches, oldest first. */
  preparing(
    limit: number,
  ): Promise<readonly { readonly nodeId: string; readonly threadId: string; readonly createdAt: Date }[]>;
  /**
   * Settles one branch if it is still preparing and no other transaction holds it: `ready` binds the
   * Scroll, `failed` closes it. Moves the revision. Returns the thread to tell, or `undefined` when
   * nothing changed.
   */
  settle(nodeId: string, settlement: Settlement, now: Date): Promise<{ readonly threadId: string } | undefined>;
  /** The branch that holds each of these Scrolls (by asset), where one does. Reads on `on`: a scope's own transaction, or the pool. */
  holdersOfAssets(
    on: ReadOn,
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly threadId: string; readonly status: NodeStatus }>>;
}

/** What the planner's worker needs. */
export interface DraftWorkerPorts {
  readonly withScope: WithPersonalScope;
  readonly guest: ThreadGuest;
  readonly store: ScenarioStore;
  /** Public metadata of the thread root: title and summary, to tell the planner and the writer what is being continued. */
  readonly readContent: ReadShareableContent;
  /** Whether the account takes part in the thread now: a read with no lock, for the worker's last check. */
  /** Whether an account takes part in a thread now, read on `on` (a caller in a transaction passes its scope). */
  readonly standing: (on: ReadOn, accountId: string, threadId: string) => Promise<boolean>;
  readonly now: () => Date;
}

/** What the HTTP commands need. */
export interface ScenarioPorts extends DraftWorkerPorts {
  readonly readSourcePages: ReadScrollSourcePages;
  readonly commission: CommissionScenarioOrder;
  /** Which of these Scrolls the caller has opened: their own exposures only ("Opened by you"). */
  readonly readVisited: ReadVisitedAssets;
  /** Sends the planner's job in the caller's transaction (once per draft). */
  readonly enqueueSuggest: (scope: PersonalScopeTx, job: { readonly draftId: string }) => Promise<void>;
  readonly hash: (operation: string, input: unknown) => string;
  /** A stable UUID derived from the parts, so a retried command finds its own rows again. */
  readonly stableId: (...parts: readonly string[]) => string;
}

/** The refusals a command can answer; HTTP maps them to its closed problems. */
export type ScenarioRefusal =
  | 'invalid_input'
  | 'unavailable'
  | 'stale_revision'
  | 'command_key_reused'
  /** The thread cannot be explored: nothing it rests on can be researched by code. */
  | 'unsupported'
  /** A cap is reached: the member's drafts of the day, the world's day of branches or the thread's branches. */
  | 'budget_unavailable';

export type Result<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly code: ScenarioRefusal };

export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
export const refuse = (code: ScenarioRefusal): Result<never> => ({ kind: 'refused', code });

/** The caller's account and epoch, as every answer names its scope. */
export function envelope(scope: PersonalScopeTx) {
  const authority: PersonalAuthority = scope.authority;
  if (authority.actor.kind !== 'account') throw new Error('SCENARIOS_ACCOUNT_REQUIRED');
  return {
    version: 'scenario.v1' as const,
    scope: { accountId: authority.actor.accountId, privacyEpoch: authority.privacyEpoch },
  };
}
