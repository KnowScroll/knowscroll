import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ProductionScopeTx,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { CONCEPTS, conceptLabel, type ReadLibraryFinds } from '../../content/public.js';
import {
  FEED_RULES,
  findTitle,
  noteProblem,
  pickFind,
  routeFeed,
  slotOf,
  type FeedCap,
  type FeedCounts,
  type FindCandidate,
} from '../domain/feed.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { UNPROMPTED_CAPS } from '../domain/router.js';
import { routeScout, scoutSilence, type ScoutCap, type ScoutCounts } from '../domain/scout.js';
import type { FeedRoom, FeedRoomRef, FeedStore, FeedTurn, FindAuthor } from './feed-ports.js';
import { makeSettle } from './feed-settle.js';
import {
  FIND_POLICY_VERSION,
  FIND_ROLE_VERSION,
  SCOUT_POLICY_VERSION,
  SCOUT_ROLE_VERSION,
  findContext,
  findRole,
  findVerdict,
  scoutRole,
  type FindVerdict,
} from './feed-role.js';

export interface FeedPassPorts {
  readonly store: FeedStore;
  readonly readFinds: ReadLibraryFinds;
  /** The model the worker is configured for; recorded on every find. */
  readonly model: string;
  /** The generation of the `rooms` root this process works under. */
  readonly generation: number;
  /**
   * One ID for the same room, kind and heartbeat slot (and, for a scout, the same owner): a repeated look finds its turn and
   * never pays twice.
   */
  readonly turnIdFor: (
    roomId: string,
    kind: 'feed_find' | 'memory_refresh' | 'scout_find',
    slot: string,
    owner?: string,
  ) => string;
  readonly newId: () => string;
  readonly now: () => Date;
}

/**
 * Who a look is for: the room's residents, who post what code picked from the room's whole topic, or one member's scout, which
 * posts what code picked from the topics its owner chose (v3 R-9). Everything else about a look is the same.
 */
export type FindSubject =
  | { readonly kind: 'residents' }
  | { readonly kind: 'scout'; readonly ownerAccountId: string; readonly interests: readonly string[] };

/** What one look at a room's finds came to. */
export type FindLook =
  /** Nothing to decide, or nobody may post now; nothing was recorded and no model was asked. */
  | { readonly kind: 'dropped'; readonly reason: string }
  /** A cap said no: a quiet ledger row, no call. */
  | { readonly kind: 'refused'; readonly cap: FeedCap | ScoutCap }
  | { readonly kind: 'posted'; readonly discussionId: string }
  /** The author had nothing worth posting about the asset. */
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
  | { readonly kind: 'refused'; readonly cap: FeedCap | ScoutCap }
  | { readonly kind: 'call'; readonly call: Call };

/** The one decision of a look, whoever it is for: nothing to do, a quiet refusal, or a post by `author`. */
type Verdict =
  | { readonly kind: 'drop'; readonly reason: string }
  | {
      readonly kind: 'refuse';
      readonly cap: FeedCap | ScoutCap;
      readonly author: FindAuthor;
      readonly counts: FeedCounts | ScoutCounts;
    }
  | { readonly kind: 'post'; readonly author: FindAuthor; readonly counts: FeedCounts | ScoutCounts };

const sameTopics = (first: readonly string[], second: readonly string[]): boolean =>
  first.length === second.length && first.every((topic) => second.includes(topic));

/** The turn's trigger, the role version a stored note records, and the run's purpose and policy, by who wrote the note. */
const flavourOf = (author: FindAuthor) =>
  author.kind === 'resident'
    ? ({
        kind: 'feed_find',
        roleVersion: FIND_ROLE_VERSION,
        policyVersion: FIND_POLICY_VERSION,
        purpose: 'feed-find',
      } as const)
    : ({
        kind: 'scout_find',
        roleVersion: SCOUT_ROLE_VERSION,
        policyVersion: SCOUT_POLICY_VERSION,
        purpose: 'scout-find',
      } as const);

/**
 * One look at one room for something to post (v3 R-8, D-248; for a member's scout v3 R-9, D-259). Three steps, the model call
 * outside any transaction: (1) the library is read for assets of the room's topic (for a scout, of the topics its owner chose)
 * that the room has not seen, and code picks one; in the room scope's transaction, with the room locked, the pure router decides
 * from rows whether anyone may post, and writes the turn's ledger row (allowed, or refused by the cap that said no); (2) one
 * model call, plus at most one repair, writes the note, on a run whose ID is the turn's; (3) one transaction checks the note and
 * who may still post, makes the discussion and its first message and settles the turn, or settles it without a post, and the
 * run is closed.
 *
 * Zero calls: a room nobody listens to, a closed room, a library with nothing new, every resident resting, a scout that is
 * paused, stopped, resting or whose owner left or paused recording, and every cap that refuses all end before step 2. A refusal
 * posts nothing and shows nothing.
 */
export function makeFeedPass(
  p: FeedPassPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
) {
  const authority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };
  const caps = { roomPerHour: UNPROMPTED_CAPS.roomPerHour, roomPerDay: UNPROMPTED_CAPS.roomPerDay };

  /** Who may post and whether they do, read under the room's lock: the residents' rule or this scout's. */
  async function decide(
    scope: ProductionScopeTx,
    locked: FeedRoom,
    subject: FindSubject,
    candidate: FindCandidate | undefined,
    now: Date,
  ): Promise<Verdict> {
    const { lastFindAt, counts } = await p.store.feedFacts(scope, locked.roomId, now);
    const open = roomAcceptsPosts(locked.status);
    if (subject.kind === 'residents') {
      const decision = routeFeed(
        {
          now,
          room: { open, cast: locked.cast.map((member) => member.inhabitant), listeners: locked.listeners },
          candidate,
          lastFindAt,
          counts,
        },
        caps,
      );
      if (decision.kind === 'drop') return decision;
      const author = { kind: 'resident', inhabitant: decision.inhabitant } as const;
      return decision.kind === 'refuse'
        ? { kind: 'refuse', cap: decision.cap, author, counts: decision.counts }
        : { kind: 'post', author, counts: decision.counts };
    }
    const standing = await p.store.scoutStanding(scope, locked.roomId, subject.ownerAccountId, now);
    // The owner changed the topics after the library was read: this look was for what they chose before. The next is for now.
    if (standing.scout !== undefined && !sameTopics(standing.scout.interests, subject.interests))
      return { kind: 'drop', reason: 'changed' };
    const decision = routeScout(
      {
        now,
        room: { open, listeners: standing.otherListeners },
        scout: standing.scout,
        owner: { member: standing.ownerIsMember, recording: standing.recording },
        candidate,
        lastPostAt: standing.lastPostAt,
        counts: { roomLastHour: counts.roomLastHour, roomToday: counts.roomToday, scoutsToday: standing.scoutsToday },
      },
      caps,
    );
    if (decision.kind === 'drop') return decision;
    const author = { kind: 'scout', ownerAccountId: subject.ownerAccountId } as const;
    return decision.kind === 'refuse'
      ? { kind: 'refuse', cap: decision.cap, author, counts: decision.counts }
      : { kind: 'post', author, counts: decision.counts };
  }

  /** Step 1: decide, under the room lock, and write the ledger row. */
  async function claim(
    scope: ProductionScopeTx,
    room: FeedRoomRef,
    subject: FindSubject,
    candidate: FindCandidate | undefined,
    turnId: string,
    now: Date,
  ): Promise<Claim> {
    const locked = await p.store.lockRoom(scope, room.roomId);
    if (locked === undefined) return { kind: 'dropped', reason: 'room_closed' };
    await p.store.lapseLost(scope, room.roomId, new Date(now.getTime() - FEED_RULES.lapsesAfterMs), now);
    // What the room remembers helps a resident write; a scout reads nothing of the room's talk.
    const memoryOf = async () =>
      subject.kind === 'residents' ? ((await p.store.memory(scope, room.roomId))?.body ?? undefined) : undefined;
    const earlier = await p.store.turn(scope, turnId);
    // The same look ran before: finish what it left, or leave what it ended.
    if (earlier !== undefined)
      return earlier.state === 'queued'
        ? { kind: 'call', call: { turn: earlier, room: locked, memory: await memoryOf() } }
        : { kind: 'dropped', reason: 'already_looked' };
    // The room may have seen the asset since the pool read: the lock makes this read exact.
    const fresh =
      candidate !== undefined && !(await p.store.seen(scope, room.roomId, candidate.assetId)) ? candidate : undefined;
    const decision = await decide(scope, locked, subject, fresh, now);
    if (decision.kind === 'drop' || fresh === undefined)
      return { kind: 'dropped', reason: decision.kind === 'drop' ? decision.reason : 'nothing_new' };
    const asset = { assetId: fresh.assetId, assetRevision: fresh.assetRevision };
    const kind = flavourOf(decision.author).kind;
    await p.store.insertTurn(scope, {
      turnId,
      roomId: room.roomId,
      kind,
      author: decision.author,
      asset,
      decision: decision.kind === 'refuse' ? { kind: 'refused', cap: decision.cap } : { kind: 'allowed' },
      counts: decision.counts,
      now,
    });
    if (decision.kind === 'refuse') return { kind: 'refused', cap: decision.cap };
    return {
      kind: 'call',
      call: {
        turn: { turnId, kind, author: decision.author, state: 'queued', asset, createdAt: now },
        room: locked,
        memory: await memoryOf(),
      },
    };
  }

  const settle = makeSettle(p.store, harness, withRoomScope, authority, p.now);

  /** Whether the author may still post, read under the room's lock just before the post. A scout is read as it stands now. */
  async function stillStands(
    scope: ProductionScopeTx,
    locked: FeedRoom | undefined,
    author: FindAuthor,
  ): Promise<boolean> {
    if (locked === undefined || !roomAcceptsPosts(locked.status)) return false;
    if (author.kind === 'resident') return locked.cast.some((member) => member.inhabitant === author.inhabitant);
    const standing = await p.store.scoutStanding(scope, locked.roomId, author.ownerAccountId, p.now());
    return (
      scoutSilence({
        room: { open: true, listeners: standing.otherListeners },
        scout: standing.scout,
        owner: { member: standing.ownerIsMember, recording: standing.recording },
      }) === undefined
    );
  }

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
      // The turn may have ended while the model was called (a Clear fails the queued turns of its owner's universe).
      const current = await p.store.turn(scope, turn.turnId);
      if (current?.state !== 'queued' || !(await stillStands(scope, locked, turn.author))) {
        await p.store.settleTurn(scope, turn.turnId, { state: 'failed', at: p.now(), dispatched: true });
        await harness.closeProductionRun(scope, { runId: turn.turnId, state: 'completed' });
        return false;
      }
      await p.store.postFind(scope, {
        turnId: turn.turnId,
        roomId: call.room.roomId,
        discussionId,
        messageId: p.newId(),
        author: turn.author,
        asset: { assetId: still.assetId, assetRevision: still.assetRevision },
        title: findTitle(still.title),
        note: text,
        at: p.now(),
        provenance: {
          roleVersion: flavourOf(turn.author).roleVersion,
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

  /** Step 2: the one model call. The role and what it reads differ by author; nothing else does. */
  function propose(call: Call, asset: FindCandidate, subject: FindSubject, signal: AbortSignal) {
    const { turn } = call;
    const topic = CONCEPTS.find((concept) => concept.id === call.room.topic.id);
    const { author } = turn;
    const flavour = flavourOf(author);
    return harness.proposeProduction(
      {
        run: {
          id: turn.turnId,
          authority,
          ownerModule: 'rooms',
          purpose: flavour.purpose,
          policyVersion: flavour.policyVersion,
        },
        role: author.kind === 'resident' ? findRole(author.inhabitant) : scoutRole(),
        context: findContext({
          turnId: turn.turnId,
          roomName: call.room.name,
          topicMeaning: topic?.meaning,
          find: asset,
          memory: call.memory,
          ...(subject.kind === 'scout'
            ? { askedFor: subject.interests.map((interest) => conceptLabel(interest)) }
            : {}),
        }),
        limits: { allowRepair: true },
      },
      signal,
    );
  }

  return async function lookForFind(room: FeedRoomRef, subject: FindSubject, signal: AbortSignal): Promise<FindLook> {
    const now = p.now();
    const scout = subject.kind === 'scout' ? subject : undefined;
    const turnId = p.turnIdFor(
      room.roomId,
      scout === undefined ? 'feed_find' : 'scout_find',
      slotOf(now),
      scout?.ownerAccountId,
    );
    // Before any transaction: what the library holds for the room's topic (a scout: the topics it was sent to), and which of it
    // the room has not seen.
    const candidates = await p.readFinds(room.topic, FEED_RULES.candidatesRead, undefined, scout?.interests);
    const seen = await p.store.seenAmong(
      room.roomId,
      candidates.map((candidate) => candidate.assetId),
    );
    const candidate = pickFind(candidates, seen);
    const claimed = await withRoomScope(authority, (scope) => claim(scope, room, subject, candidate, turnId, now));
    if (claimed.kind !== 'entered') return { kind: 'dropped', reason: claimed.refusal.kind };
    const outcome = claimed.value;
    if (outcome.kind === 'dropped' || outcome.kind === 'refused') return outcome;
    const asset = await assetOfTurn(outcome.call);
    if (asset === undefined) {
      // Nothing was asked of the provider and no run was opened: the turn is handed back and a later look may try another asset.
      await settle(turnId, { state: 'failed', dispatched: false }, undefined);
      return { kind: 'not_made', reason: 'asset_withdrawn' };
    }
    return finish(outcome.call, asset, findVerdict(await propose(outcome.call, asset, subject, signal)));
  };
}
