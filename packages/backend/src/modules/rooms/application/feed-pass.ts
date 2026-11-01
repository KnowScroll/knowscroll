import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ProductionScopeTx,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { CONCEPTS, type ReadLibraryFinds } from '../../content/public.js';
import {
  FEED_RULES,
  findTitle,
  noteProblem,
  pickFind,
  routeFeed,
  slotOf,
  type FeedCap,
  type FindCandidate,
} from '../domain/feed.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { UNPROMPTED_CAPS } from '../domain/router.js';
import type { FeedRoom, FeedRoomRef, FeedStore, FeedTurn } from './feed-ports.js';
import { makeSettle } from './feed-settle.js';
import {
  FIND_POLICY_VERSION,
  FIND_ROLE_VERSION,
  findContext,
  findRole,
  findVerdict,
  type FindVerdict,
} from './feed-role.js';

export interface FeedPassPorts {
  readonly store: FeedStore;
  readonly readFinds: ReadLibraryFinds;
  /** The model the worker is configured for; recorded on every find. */
  readonly model: string;
  /** The generation of the `rooms` root this process works under. */
  readonly generation: number;
  /** One ID for the same room, kind and heartbeat slot: a repeated look finds its turn and never pays twice. */
  readonly turnIdFor: (roomId: string, kind: 'feed_find' | 'memory_refresh', slot: string) => string;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** What one look at a room's finds came to. */
export type FindLook =
  /** Nothing to decide, or nobody may post now; nothing was recorded and no model was asked. */
  | { readonly kind: 'dropped'; readonly reason: string }
  /** A cap said no: a quiet ledger row, no call. */
  | { readonly kind: 'refused'; readonly cap: FeedCap }
  | { readonly kind: 'posted'; readonly discussionId: string }
  /** The resident had nothing worth posting about the asset. */
  | { readonly kind: 'declined' }
  /** The call came to nothing, or the note failed the checks: nothing is posted. */
  | { readonly kind: 'not_made'; readonly reason: string };

/** The turn a look will make a call for, with what the model reads. */
interface Call {
  readonly turn: FeedTurn;
  readonly room: FeedRoom;
  readonly memory: string | undefined;
}

type Claim =
  | { readonly kind: 'dropped'; readonly reason: string }
  | { readonly kind: 'refused'; readonly cap: FeedCap }
  | { readonly kind: 'call'; readonly call: Call };

/**
 * One resident's look at one room for something to post (v3 R-8, D-248). Three steps, the model call outside any transaction:
 * (1) the library is read for assets of the room's topic that the room has not seen, and code picks one; in the room scope's
 * transaction, with the room locked, the pure router decides from rows whether a resident may post, and writes the turn's
 * ledger row (allowed, or refused by the cap that said no); (2) one model call, plus at most one repair, writes the note, on a
 * run whose ID is the turn's; (3) one transaction checks the note again, makes the discussion and its first message and
 * settles the turn, or settles it without a post, and the run is closed.
 *
 * Zero calls: a room nobody listens to, a closed room, a library with nothing new, every resident resting and every cap that
 * refuses all end before step 2. A refusal posts nothing and shows nothing.
 */
export function makeFeedPass(
  p: FeedPassPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
) {
  const authority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };

  /** Step 1: decide, under the room lock, and write the ledger row. */
  async function claim(
    scope: ProductionScopeTx,
    room: FeedRoomRef,
    candidate: FindCandidate | undefined,
    turnId: string,
    now: Date,
  ): Promise<Claim> {
    const locked = await p.store.lockRoom(scope, room.roomId);
    if (locked === undefined) return { kind: 'dropped', reason: 'room_closed' };
    await p.store.lapseLost(scope, room.roomId, new Date(now.getTime() - FEED_RULES.lapsesAfterMs), now);
    const earlier = await p.store.turn(scope, turnId);
    // The same look ran before: finish what it left, or leave what it ended.
    if (earlier !== undefined)
      return earlier.state === 'queued'
        ? {
            kind: 'call',
            call: {
              turn: earlier,
              room: locked,
              memory: (await p.store.memory(scope, room.roomId))?.body ?? undefined,
            },
          }
        : { kind: 'dropped', reason: 'already_looked' };
    const { lastFindAt, counts } = await p.store.feedFacts(scope, room.roomId, now);
    // The room may have seen the asset since the pool read: the lock makes this read exact.
    const fresh =
      candidate !== undefined && !(await p.store.seen(scope, room.roomId, candidate.assetId)) ? candidate : undefined;
    const decision = routeFeed(
      {
        now,
        room: {
          open: roomAcceptsPosts(locked.status),
          cast: locked.cast.map((member) => member.inhabitant),
          listeners: locked.listeners,
        },
        candidate: fresh,
        lastFindAt,
        counts,
      },
      { roomPerHour: UNPROMPTED_CAPS.roomPerHour, roomPerDay: UNPROMPTED_CAPS.roomPerDay },
    );
    if (decision.kind === 'drop' || fresh === undefined)
      return { kind: 'dropped', reason: decision.kind === 'drop' ? decision.reason : 'nothing_new' };
    const asset = { assetId: fresh.assetId, assetRevision: fresh.assetRevision };
    await p.store.insertTurn(scope, {
      turnId,
      roomId: room.roomId,
      kind: 'feed_find',
      inhabitant: decision.inhabitant,
      asset,
      decision: decision.kind === 'refuse' ? { kind: 'refused', cap: decision.cap } : { kind: 'allowed' },
      counts: decision.counts,
      now,
    });
    if (decision.kind === 'refuse') return { kind: 'refused', cap: decision.cap };
    const memory = (await p.store.memory(scope, room.roomId))?.body ?? undefined;
    return {
      kind: 'call',
      call: {
        turn: { turnId, kind: 'feed_find', inhabitant: decision.inhabitant, state: 'queued', asset, createdAt: now },
        room: locked,
        memory,
      },
    };
  }

  const settle = makeSettle(p.store, harness, withRoomScope, authority, p.now);

  /** Step 3 for a note: the checks again, the asset again, then the post. */
  async function post(call: Call, asset: FindCandidate, text: string, attemptId: string): Promise<FindLook> {
    const { turn } = call;
    // The model's note passed the answer schema; it is checked again where it is stored, as a Spot the flaw sentence is.
    if (noteProblem(text) !== undefined) {
      await settle(turn.turnId, { state: 'failed', dispatched: true }, 'failed');
      return { kind: 'not_made', reason: 'invalid_output' };
    }
    // The asset must still be a current, served one: a post that links nothing is not made.
    const [still] = await p.readFinds(call.room.topic, 1, {
      assetId: asset.assetId,
      assetRevision: asset.assetRevision,
    });
    if (still === undefined) {
      await settle(turn.turnId, { state: 'failed', dispatched: true }, 'completed');
      return { kind: 'not_made', reason: 'asset_withdrawn' };
    }
    const discussionId = p.newId();
    const result = await withRoomScope(authority, async (scope) => {
      const locked = await p.store.lockRoom(scope, call.room.roomId);
      const resident = locked?.cast.some((member) => member.inhabitant === turn.inhabitant) === true;
      if (locked === undefined || !roomAcceptsPosts(locked.status) || !resident) {
        await p.store.settleTurn(scope, turn.turnId, { state: 'failed', at: p.now(), dispatched: true });
        await harness.closeProductionRun(scope, { runId: turn.turnId, state: 'completed' });
        return false;
      }
      await p.store.postFind(scope, {
        turnId: turn.turnId,
        roomId: call.room.roomId,
        discussionId,
        messageId: p.newId(),
        inhabitant: turn.inhabitant,
        asset: { assetId: still.assetId, assetRevision: still.assetRevision },
        title: findTitle(still.title),
        note: text,
        at: p.now(),
        provenance: {
          roleVersion: FIND_ROLE_VERSION,
          promptVersion: HARNESS_PROMPT_VERSION,
          model: p.model,
          attemptId,
        },
      });
      await harness.closeProductionRun(scope, { runId: turn.turnId, state: 'completed' });
      return true;
    });
    if (result.kind !== 'entered' || !result.value) return { kind: 'not_made', reason: 'room_changed' };
    return { kind: 'posted', discussionId };
  }

  /** Step 3 for any verdict. */
  async function finish(call: Call, asset: FindCandidate, verdict: FindVerdict): Promise<FindLook> {
    if (verdict.kind === 'find') return post(call, asset, verdict.text, verdict.attemptId);
    if (verdict.kind === 'nothing_to_add') {
      await settle(call.turn.turnId, { state: 'declined', dispatched: true }, 'completed');
      return { kind: 'declined' };
    }
    await settle(call.turn.turnId, { state: 'failed', dispatched: verdict.dispatched }, verdict.end);
    return { kind: 'not_made', reason: 'call_failed' };
  }

  /** The asset of a turn the look resumes, read afresh: a find about something no longer served is not made. */
  async function assetOfTurn(call: Call): Promise<FindCandidate | undefined> {
    const target = call.turn.asset;
    if (target === undefined) return undefined;
    const [found] = await p.readFinds(call.room.topic, 1, target);
    return found;
  }

  return async function lookForFind(room: FeedRoomRef, signal: AbortSignal): Promise<FindLook> {
    const now = p.now();
    const turnId = p.turnIdFor(room.roomId, 'feed_find', slotOf(now));
    // Before any transaction: what the library holds for the room's topic, and which of it the room has not seen.
    const candidates = await p.readFinds(room.topic, FEED_RULES.candidatesRead);
    const seen = await p.store.seenAmong(
      room.roomId,
      candidates.map((candidate) => candidate.assetId),
    );
    const candidate = pickFind(candidates, seen);
    const claimed = await withRoomScope(authority, (scope) => claim(scope, room, candidate, turnId, now));
    if (claimed.kind === 'entered') {
      const outcome = claimed.value;
      if (outcome.kind === 'dropped') return outcome;
      if (outcome.kind === 'refused') return outcome;
      const asset = await assetOfTurn(outcome.call);
      if (asset === undefined) {
        // Nothing was asked of the provider and no run was opened: the turn is handed back and a later look may try another asset.
        await settle(turnId, { state: 'failed', dispatched: false }, undefined);
        return { kind: 'not_made', reason: 'asset_withdrawn' };
      }
      const topic = CONCEPTS.find((concept) => concept.id === room.topic.id);
      const verdict = findVerdict(
        await harness.proposeProduction(
          {
            run: {
              id: turnId,
              authority,
              ownerModule: 'rooms',
              purpose: 'feed-find',
              policyVersion: FIND_POLICY_VERSION,
            },
            role: findRole(outcome.call.turn.inhabitant),
            context: findContext({
              turnId,
              roomName: outcome.call.room.name,
              topicMeaning: topic?.meaning,
              find: asset,
              memory: outcome.call.memory,
            }),
            limits: { allowRepair: true },
          },
          signal,
        ),
      );
      return finish(outcome.call, asset, verdict);
    }
    return { kind: 'dropped', reason: claimed.refusal.kind };
  };
}
