import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ProductionScopeTx,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { CONCEPTS } from '../../content/public.js';
import { FEED_RULES, slotOf } from '../domain/feed.js';
import { MEMORY_RULES, memoryDue, memoryProblem } from '../domain/memory.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { UNPROMPTED_CAPS } from '../domain/router.js';
import type { FeedRoom, FeedRoomRef, FeedStore, FeedTurn, MemoryMessage } from './feed-ports.js';
import type { FeedPassPorts } from './feed-pass.js';
import { makeSettle } from './feed-settle.js';
import {
  MEMORY_POLICY_VERSION,
  MEMORY_ROLE_VERSION,
  memoryContext,
  memoryRole,
  memoryVerdict,
  type MemoryMaterial,
} from './memory-role.js';

/** A refresh that made a call and wrote nothing waits this long before the room is asked about again. */
const UNWRITTEN_REST_MS = 24 * 60 * 60_000;

/** What one look at a room's memory came to. */
export type MemoryLook =
  | { readonly kind: 'dropped'; readonly reason: string }
  | { readonly kind: 'refused'; readonly cap: 'room_hour' | 'room_day' }
  | { readonly kind: 'written' }
  /** The resident found nothing worth keeping, or what it read was removed while it worked: nothing was stored. */
  | { readonly kind: 'not_written'; readonly reason: string };

interface Call {
  readonly turn: FeedTurn;
  readonly room: FeedRoom;
  readonly window: readonly MemoryMessage[];
  /** The members' display names and handles when the call was made: a memory that names one is refused. */
  readonly memberNames: readonly string[];
}

type Claim =
  | { readonly kind: 'dropped'; readonly reason: string }
  | { readonly kind: 'refused'; readonly cap: 'room_hour' | 'room_day' }
  | { readonly kind: 'call'; readonly call: Call };

/**
 * The retained messages as the model reads them: numbered speakers in order of first appearance, and each message cut to a
 * bounded length. Who wrote what is never in the material, and a member who keeps theirs out is not in the window at all.
 */
export function memoryMaterial(
  parts: { readonly turnId: string; readonly room: FeedRoom },
  window: readonly MemoryMessage[],
): MemoryMaterial {
  const numbers = new Map<string, number>();
  const topic = CONCEPTS.find((concept) => concept.id === parts.room.topic.id);
  return {
    turnId: parts.turnId,
    roomName: parts.room.name,
    topicMeaning: topic?.meaning,
    messages: window.map((message) => {
      if (!numbers.has(message.accountId)) numbers.set(message.accountId, numbers.size + 1);
      return {
        speaker: `Member ${String(numbers.get(message.accountId))}`,
        text: [...message.text].slice(0, MEMORY_RULES.messageChars).join(''),
      };
    }),
  };
}

/**
 * The room's memory written again when it is due (v3 R-8, D-247): the first text once there is enough to remember, again after
 * something it read was removed, kept out or deleted, and again after enough new messages. The same three steps as every
 * resident call, in the room scope's transaction and outside it: (1) with the room locked, code decides from rows whether a
 * refresh is due and allowed, and writes the turn's ledger row; (2) one call, plus at most one repair; (3) one transaction
 * checks that everything the call read is still retained, checks the words, stores them (unless a moderator's text stands now)
 * and settles the turn. The words are bounded and replace what stood: nothing is appended.
 *
 * Zero calls: fewer than a handful of readable messages, nothing removed or new, a moderator's text standing, a room nobody
 * listens to, a rest after a refresh that wrote nothing, and a cap all end before step 2.
 */
export function makeMemoryRefresh(
  p: Pick<FeedPassPorts, 'store' | 'model' | 'generation' | 'turnIdFor' | 'now'>,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
) {
  const authority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };
  const store: FeedStore = p.store;

  async function claim(scope: ProductionScopeTx, room: FeedRoomRef, turnId: string, now: Date): Promise<Claim> {
    const locked = await store.lockRoom(scope, room.roomId);
    if (locked === undefined) return { kind: 'dropped', reason: 'room_closed' };
    await store.lapseLost(scope, room.roomId, new Date(now.getTime() - FEED_RULES.lapsesAfterMs), now);
    const window = await store.memoryWindow(scope, room.roomId, MEMORY_RULES.windowMessages);
    const callOf = async (turn: FeedTurn): Promise<Claim> => ({
      kind: 'call',
      call: { turn, room: locked, window, memberNames: await store.memberNames(scope, room.roomId) },
    });
    const earlier = await store.turn(scope, turnId);
    if (earlier !== undefined)
      return earlier.state === 'queued' ? callOf(earlier) : { kind: 'dropped', reason: 'already_looked' };
    if (!roomAcceptsPosts(locked.status) || locked.listeners === 0)
      return { kind: 'dropped', reason: locked.listeners === 0 ? 'nobody_listening' : 'room_closed' };
    const memory = await store.memory(scope, room.roomId);
    const newSince =
      memory?.source === 'derived' && memory.state === 'ready' && memory.coversThrough !== undefined
        ? window.filter((message) => message.recordedAt > memory.coversThrough!).length
        : 0;
    const trigger = memoryDue({
      state: memory?.state ?? 'none',
      source: memory?.source,
      readable: window.length,
      newSince,
    });
    if (trigger === undefined) return { kind: 'dropped', reason: 'not_due' };
    if (
      (await store.lastUnwrittenRefreshAt(scope, room.roomId, new Date(now.getTime() - UNWRITTEN_REST_MS))) !==
      undefined
    )
      return { kind: 'dropped', reason: 'resting' };
    const { counts } = await store.feedFacts(scope, room.roomId, now);
    const cap =
      counts.roomLastHour >= UNPROMPTED_CAPS.roomPerHour
        ? 'room_hour'
        : counts.roomToday >= UNPROMPTED_CAPS.roomPerDay
          ? 'room_day'
          : undefined;
    const inhabitant = locked.cast[0]?.inhabitant ?? 'explainer';
    await store.insertTurn(scope, {
      turnId,
      roomId: room.roomId,
      kind: 'memory_refresh',
      inhabitant,
      asset: undefined,
      decision: cap === undefined ? { kind: 'allowed' } : { kind: 'refused', cap },
      counts,
      now,
    });
    if (cap !== undefined) return { kind: 'refused', cap };
    return callOf({ turnId, kind: 'memory_refresh', inhabitant, state: 'queued', asset: undefined, createdAt: now });
  }

  /**
   * Step 3: store the words if everything the call read is still retained and the words still pass, and settle the turn
   * either way. The room's row is taken exclusively first: a removal, a keep-out and a deletion each take it shared before
   * they touch a message, so one that has not committed is waited for, and one that comes later waits for this transaction
   * and then erases what is stored here (D-247). The members' names are read again, as they are now.
   */
  async function apply(call: Call, text: string, attemptId: string): Promise<MemoryLook> {
    const { turn, window } = call;
    const stored = await withRoomScope(authority, async (scope) => {
      const at = p.now();
      const locked = await store.lockRoom(scope, call.room.roomId);
      const retained =
        locked === undefined
          ? 0
          : await store.stillReadable(
              scope,
              call.room.roomId,
              window.map((message) => message.messageId),
            );
      // A message it read was removed, kept out or deleted while the call ran: the words are never stored. The call was made.
      const words =
        locked !== undefined &&
        retained === window.length &&
        memoryProblem(text, 'residents', await store.memberNames(scope, call.room.roomId)) === undefined;
      if (words)
        await store.storeMemory(scope, {
          roomId: call.room.roomId,
          turnId: turn.turnId,
          body: text,
          coversFrom: window[0]!.recordedAt,
          coversThrough: window.at(-1)!.recordedAt,
          messagesRead: window.length,
          at,
        });
      await store.settleTurn(
        scope,
        turn.turnId,
        words
          ? {
              state: 'completed',
              at,
              provenance: {
                roleVersion: MEMORY_ROLE_VERSION,
                promptVersion: HARNESS_PROMPT_VERSION,
                model: p.model,
                attemptId,
              },
            }
          : { state: 'failed', at, dispatched: true },
      );
      await harness.closeProductionRun(scope, { runId: turn.turnId, state: 'completed' });
      return words;
    });
    return stored.kind === 'entered' && stored.value
      ? { kind: 'written' }
      : { kind: 'not_written', reason: 'not_stored' };
  }

  const settle = makeSettle(store, harness, withRoomScope, authority, p.now);

  return async function refreshMemory(room: FeedRoomRef, signal: AbortSignal): Promise<MemoryLook> {
    const now = p.now();
    const turnId = p.turnIdFor(room.roomId, 'memory_refresh', slotOf(now));
    const claimed = await withRoomScope(authority, (scope) => claim(scope, room, turnId, now));
    if (claimed.kind !== 'entered') return { kind: 'dropped', reason: claimed.refusal.kind };
    const outcome = claimed.value;
    if (outcome.kind !== 'call') return outcome;
    const verdict = memoryVerdict(
      await harness.proposeProduction(
        {
          run: {
            id: turnId,
            authority,
            ownerModule: 'rooms',
            purpose: 'memory-refresh',
            policyVersion: MEMORY_POLICY_VERSION,
          },
          role: memoryRole(outcome.call.memberNames),
          context: memoryContext(memoryMaterial({ turnId, room: outcome.call.room }, outcome.call.window)),
          limits: { allowRepair: true },
        },
        signal,
      ),
    );
    if (verdict.kind === 'memory') return apply(outcome.call, verdict.text, verdict.attemptId);
    if (verdict.kind === 'nothing_to_add') {
      await settle(turnId, { state: 'declined', dispatched: true }, 'completed');
      return { kind: 'not_written', reason: 'nothing_to_keep' };
    }
    await settle(turnId, { state: 'failed', dispatched: verdict.dispatched }, verdict.end);
    return { kind: 'not_written', reason: 'call_failed' };
  };
}
