import {
  LockThreadCallSchema,
  ReadThreadCallsSchema,
  ThreadCallLockAcceptanceSchema,
  ThreadCallsSchema,
  type ThreadCall,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { ScrollCallFacts } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { revealedForThread, threadCallOf, viewCall, type CallView } from '../domain/calls.js';
import { dayOf } from '../domain/places.js';
import { refuse, threadEnvelope, type Result } from './ports.js';
import { makeThreadCommandFrame, ok, takingPart } from './thread-command-frame.js';
import { enterThread, threadRefOf, type EnteredThread } from './thread-gate.js';
import type { CallKey, ThreadCallPorts, ThreadMember, ThreadRow } from './thread-ports.js';

/** The call a part of the thread's series offers: the part, the exact revision and its first Call it. */
interface PartCall {
  readonly part: number;
  readonly assetId: string;
  readonly revision: number;
  readonly call: ScrollCallFacts;
}

const keyOf = (target: PartCall): CallKey => ({
  assetId: target.assetId,
  revision: target.revision,
  stopId: target.call.stopId,
});

const sameCall = (row: CallKey, key: CallKey): boolean =>
  row.assetId === key.assetId && row.revision === key.revision && row.stopId === key.stopId;

/**
 * "Call it together" (T3, D-155 to D-157): before a part whose Scroll has an authored question, each member of a
 * thread locks a pick. Nobody sees another member's pick until they have locked their own and the party has finished
 * the part, so a pick is a guess made before the part. Each command and read runs in the caller's personal scope in
 * the thread's lock order (personal root, own account gate, the thread's own root) and rechecks membership, so a
 * stranger, a leaver and a removed member get nothing and cannot tell why.
 *
 * A pick is a play result (D-063). It is shown to the thread's members after the reveal and to the person in their
 * export, and no ranking, planning, evidence, formation or Composer path reads it. No model is called, and no
 * answer carries a time finer than a day. The right answer is read from the immutable revision when a reveal is
 * built and is never stored or sent before it. Nothing counts picks across threads (D-157).
 */
export function makeThreadCalls(p: ThreadCallPorts) {
  const { inThreadWithoutReceipt } = makeThreadCommandFrame(p);

  /** The parts of the thread's series that have an authored call, in part order; none for a single item. */
  async function callsOfSeries(scope: PersonalScopeTx, thread: ThreadRow): Promise<readonly PartCall[]> {
    const sequence = await p.readSequence(scope, thread.root);
    if (sequence?.kind !== 'series') return [];
    const found: PartCall[] = [];
    for (const unit of sequence.units) {
      if (unit.kind !== 'scroll') continue;
      const facts = await p.readCallFacts(scope, unit.assetId, unit.assetRevision);
      const call = facts === undefined ? undefined : threadCallOf(facts.calls);
      if (call !== undefined)
        found.push({ part: unit.part, assetId: unit.assetId, revision: unit.assetRevision, call });
    }
    return found.toSorted((left, right) => left.part - right.part);
  }

  /**
   * The rows a reveal rule reads, all under the thread's lock: every lock, every place, the days calls already
   * revealed, and the blocks the reader has.
   */
  async function partyOf(entered: EnteredThread) {
    const locks = await p.calls.list(entered.lock);
    const places = await p.places.list(entered.lock);
    const reveals = await p.calls.reveals(entered.lock);
    const blocked = await p.places.blockedWith(
      entered.lock,
      entered.owner.accountId,
      entered.members.map((member) => member.accountId),
    );
    return { locks, places, reveals, blocked };
  }
  type Party = Awaited<ReturnType<typeof partyOf>>;

  /**
   * The day a call revealed for the thread, or none. The first time the rule holds for the whole thread the day is
   * recorded, so a call that has revealed stays revealed when the earliest locker leaves or clears (D-155). A read may
   * write it, once, to a row of its own.
   */
  async function revealedOn(
    entered: EnteredThread,
    target: PartCall,
    party: Party,
    now: Date,
  ): Promise<string | undefined> {
    const key = keyOf(target);
    const stored = party.reveals.find((row) => sameCall(row, key));
    if (stored !== undefined) return stored.day;
    const today = dayOf(now);
    const revealed = revealedForThread({
      part: target.part,
      members: entered.members,
      locks: party.locks.filter((row) => sameCall(row, key)),
      places: party.places,
      today,
    });
    if (!revealed) return undefined;
    await p.calls.markRevealed(entered.lock, key, today);
    return today;
  }

  /** What one reader may see of one call now, from the rows of the thread read under its lock. */
  async function viewOf(
    entered: EnteredThread,
    target: PartCall,
    party: Party,
    now: Date,
  ): Promise<CallView<ThreadMember>> {
    const key = keyOf(target);
    return viewCall({
      readerAccountId: entered.owner.accountId,
      part: target.part,
      answer: target.call.answer,
      members: entered.members,
      locks: party.locks.filter((row) => sameCall(row, key)),
      places: party.places,
      blockedWithReader: party.blocked,
      today: dayOf(now),
      revealedOn: await revealedOn(entered, target, party, now),
      nameOf: (member) => member.person.displayName,
    });
  }

  function present(entered: EnteredThread, target: PartCall, view: CallView<ThreadMember>): ThreadCall {
    const base = {
      part: target.part,
      assetId: target.assetId,
      assetRevision: target.revision,
      prompt: target.call.prompt,
      options: [...target.call.options],
      called: view.called,
      of: view.of,
    };
    switch (view.stage) {
      case 'open':
        return { ...base, stage: 'open' };
      case 'locked':
        return { ...base, stage: 'locked', option: view.option };
      case 'closed':
        return { ...base, stage: 'closed', reason: view.reason };
      case 'revealed': {
        const right = view.option === target.call.answer;
        // The Scroll's own authored, reviewed common guess, shown as the reader shows it: to a person who picked it (D-157).
        const guess = target.call.commonGuess;
        return {
          ...base,
          stage: 'revealed',
          option: view.option,
          answer: target.call.answer,
          explain: target.call.explain,
          ...(right ? {} : { twist: target.call.twist }),
          right,
          picks: view.picks.map((pick) => ({
            person: pick.member.person,
            you: pick.member.accountId === entered.owner.accountId,
            option: pick.option,
            right: pick.right,
          })),
          rightCount: view.rightCount,
          ...(guess?.option === view.option ? { guessSource: guess.source } : {}),
        };
      }
    }
  }

  return {
    /**
     * The calls of the thread's series as the caller may see them, read under the thread's lock. A read writes no
     * receipt, notice or evidence and works while recording is paused; the one thing it may write is the day a call
     * first revealed for the thread, once, to a row that names no person (D-155). A single-item thread, a Reel and a
     * Scroll without a call have none.
     */
    async calls(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadCallsSchema>>> {
      const parsed = ReadThreadCallsSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...threadEnvelope(scope), readId: query.readId };
        const entered = await enterThread(p, scope, query.thread, 'read');
        if (!entered) return ok(ThreadCallsSchema.parse({ ...envelope, status: 'unavailable' }));
        const targets = await callsOfSeries(scope, entered.thread);
        const calls: ThreadCall[] = [];
        if (targets.length > 0) {
          const party = await partyOf(entered);
          for (const target of targets) {
            calls.push(present(entered, target, await viewOf(entered, target, party, p.now())));
          }
        }
        return ok(ThreadCallsSchema.parse({ ...envelope, status: 'ready', thread: threadRefOf(entered), calls }));
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * Locks the caller's pick on the call of one part. Authority: the caller's personal scope, then the thread's
     * lock; the caller must take part. Recording must be on and the generation current (D-083): otherwise nothing is
     * stored and the answer says why. The part must have an authored call and the option must be one of its options,
     * or the command is invalid. The pick is stored only while the call is open to the caller: not once they started
     * the part or the party revealed. The first lock stands, a repeat or another pick answers `stands` and changes
     * nothing, and no receipt is kept (D-156). A new lock tells every member's open thread to read again (a disposable
     * hint that carries nothing). It is not consumption evidence for anyone.
     */
    lockCall(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadCallLockAcceptanceSchema>>> {
      const parsed = LockThreadCallSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThreadWithoutReceipt<z.infer<typeof ThreadCallLockAcceptanceSchema>>(authority, {
        command,
        async decide({ scope, entered, now }) {
          const accepted = (result: 'locked' | 'stands' | 'closed') =>
            ThreadCallLockAcceptanceSchema.parse({
              ...threadEnvelope(scope),
              operation: 'thread.call-lock',
              recorded: true,
              thread: threadRefOf(entered),
              part: command.part,
              result,
            });
          const gate = await p.fenceRecording(scope, command.recordingGeneration);
          if (gate.kind === 'paused' || gate.kind === 'stale') {
            const refused = ThreadCallLockAcceptanceSchema.parse({
              ...threadEnvelope(scope),
              operation: 'thread.call-lock',
              recorded: false,
              reason: gate.kind === 'paused' ? 'recording_paused' : 'recording_generation_stale',
              currentGeneration: gate.currentGeneration,
            });
            return ok({ write: () => Promise.resolve(refused), announce: [] });
          }
          if (gate.kind !== 'recording') return refuse('unavailable');

          const target = (await callsOfSeries(scope, entered.thread)).find(
            (candidate) => candidate.part === command.part,
          );
          if (target === undefined || command.option >= target.call.optionCount) return refuse('invalid_input');
          const view = await viewOf(entered, target, await partyOf(entered), now);
          if (view.stage === 'locked' || view.stage === 'revealed')
            return ok({ write: () => Promise.resolve(accepted('stands')), announce: [] });
          if (view.stage === 'closed') return ok({ write: () => Promise.resolve(accepted('closed')), announce: [] });
          return ok({
            write: async () => {
              await p.calls.insert(entered.lock, entered.owner.accountId, keyOf(target), command.option, dayOf(now));
              return accepted('locked');
            },
            announce: takingPart(entered),
          });
        },
      });
    },
  };
}
