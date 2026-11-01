import { ChallengeLockAcceptanceSchema, LockChallengePickSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { dayOf } from '../domain/places.js';
import { enterConversation, refOf } from './conversation-gate.js';
import type { ConversationPorts, InboxChange } from './conversation-ports.js';
import { conversationEnvelope, refuse, type Result } from './ports.js';

type Acceptance = z.infer<typeof ChallengeLockAcceptanceSchema>;

/**
 * Locks the caller's pick on a challenge card (D-245). Authority: the caller's personal scope, then the friendship's
 * lock; the conversation must be open to the caller and the card must be a challenge of this conversation that still
 * stands, so a stranger, a person who left, a blocked pair and a message that is not a challenge are all `unavailable`
 * and cannot be told apart. Recording must be on and the generation current (D-083): otherwise nothing is stored and the
 * answer says why. The option must be one of the call's options. The first lock stands: a repeat, or another pick, answers
 * `stands` and changes nothing, and no receipt is kept, because a receipt would keep the time of a pick (D-156). A pick that reveals
 * (the friend has already called) gives the message a fresh change number and tells both people's inboxes, so the friend's
 * card moves within seconds (disposable hints carry only IDs). A pick made before the friend has called moves nothing on
 * the friend's side, so the wire never says whether the friend has called. It is not consumption evidence for anyone and is never read by ranking.
 */
export function makeChallengeLock(p: ConversationPorts) {
  return {
    async lockChallenge(authority: PersonalAuthority, input: unknown): Promise<Result<Acceptance>> {
      const parsed = LockChallengePickSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const command = parsed.data;
      const result = await p.withScope(authority, async (scope): Promise<Result<Acceptance>> => {
        const entered = await enterConversation(p, scope, command.conversation);
        if (!entered?.lock || entered.conversation.closed) return refuse('unavailable');
        const envelope = conversationEnvelope(scope);
        const gate = await p.fenceRecording(scope, command.recordingGeneration);
        if (gate.kind === 'paused' || gate.kind === 'stale')
          return {
            kind: 'ok',
            value: ChallengeLockAcceptanceSchema.parse({
              ...envelope,
              operation: 'challenge.lock',
              recorded: false,
              reason: gate.kind === 'paused' ? 'recording_paused' : 'recording_generation_stale',
              currentGeneration: gate.currentGeneration,
            }),
          };
        if (gate.kind !== 'recording') return refuse('unavailable');

        const conversationId = entered.conversation.conversationId;
        const challenge = await p.conversations.challengeOf(entered.lock, conversationId, command.messageId);
        if (challenge === undefined) return refuse('unavailable');
        const facts = await p.readCallFacts(scope, challenge.assetId, challenge.revision);
        const call = facts?.calls.find((candidate) => candidate.stopId === challenge.stopId);
        if (call === undefined) return refuse('unavailable');
        if (command.option >= call.optionCount) return refuse('invalid_input');

        const picks = await p.conversations.picksOf(entered.lock, conversationId, [challenge]);
        const standing = picks.some((pick) => pick.accountId === entered.owner.accountId);
        if (!standing) {
          await p.conversations.insertPick(
            entered.lock,
            conversationId,
            entered.owner.accountId,
            challenge,
            command.option,
            dayOf(p.now()),
          );
          // The friend's card changes only when this pick reveals (the friend has already called). Before that it stays
          // `open` for them, so nothing may move on their side: no new change number for the message and no hint to their
          // inbox, or a network observer would learn that this person has called. The person's own client reads the thread
          // again after its lock.
          const reveals = picks.some((pick) => pick.accountId !== entered.owner.accountId);
          const own: InboxChange = { accountId: entered.owner.accountId, universeId: entered.owner.universeId };
          const inboxes: InboxChange[] =
            reveals && entered.peerAccess !== undefined
              ? [own, { accountId: entered.peerAccess.accountId, universeId: entered.peerAccess.universeId }]
              : [own];
          if (reveals) await p.conversations.touchMessage(entered.lock, conversationId, challenge.sequence);
          await p.conversations.announce(entered.reader, inboxes, () => p.newId());
        }
        return {
          kind: 'ok',
          value: ChallengeLockAcceptanceSchema.parse({
            ...envelope,
            operation: 'challenge.lock',
            recorded: true,
            conversation: refOf(entered),
            messageId: command.messageId,
            result: standing ? 'stands' : 'locked',
          }),
        };
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
