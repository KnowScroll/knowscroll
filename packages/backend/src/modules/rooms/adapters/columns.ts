import type { AskKind } from '../domain/asks.js';
import type { ContributionKind, InhabitantId } from '../domain/contribution.js';
import type { AiLevel, JoinRule, RoomRole, RoomStatus } from '../domain/membership.js';
import type { MessageTrigger } from '../domain/triggers.js';
import type { SummaryState, TopicTag, TurnState, TurnTrigger } from '../application/ports.js';
import type { ReviewState } from '../application/face-ports.js';
import type { BackdropAttemptState } from '../domain/backdrop-spend.js';

/**
 * The text columns of migration 0062 are closed sets by CHECK constraints, but the generated row types
 * only know `string`. Each reader names the set once and refuses a value outside it, so a schema that
 * drifts fails loudly here instead of reaching a use case as an impossible value.
 */
function closed<T extends string>(column: string, values: readonly T[]): (value: string | null) => T {
  return (value) => {
    const found = values.find((candidate) => candidate === value);
    if (found === undefined) throw new Error(`ROOMS_COLUMN_OUT_OF_RANGE: ${column}`);
    return found;
  };
}

export const inhabitantOf = closed<InhabitantId>('inhabitant', ['explainer', 'skeptic']);
export const contributionKindOf = closed<ContributionKind>('ai_kind', [
  'explanation',
  'assumption',
  'perspective',
  'counterexample',
  'find',
]);
export const roleOf = closed<RoomRole>('role', ['member', 'moderator']);
export const aiLevelOf = closed<AiLevel>('ai_level', ['lively', 'quieter', 'off']);
export const discussionKindOf = closed<'general' | 'topic' | 'today' | 'find' | 'intro'>('kind', [
  'general',
  'topic',
  'today',
  'find',
  'intro',
]);
export const joinRuleOf = closed<JoinRule>('join_rule', ['open', 'friends_of_members', 'invite_only']);
export const statusOf = closed<RoomStatus>('status', ['open', 'paused', 'closed']);
export const topicKindOf = closed<'system' | 'planet'>('topic_kind', ['system', 'planet']);
export const endedByOf = closed<'left' | 'removed'>('ended_by', ['left', 'removed']);
export const turnStateOf = closed<TurnState>('state', ['queued', 'completed', 'declined', 'failed', 'refused']);
export const messageTriggerOf = closed<MessageTrigger>('trigger', [
  'unanswered_question',
  'overstated_claim',
  'answer_overstated',
  'feed_find',
  'scout_find',
]);
export const turnTriggerOf = closed<TurnTrigger>('trigger', [
  'asked',
  'unanswered_question',
  'overstated_claim',
  'answer_overstated',
]);

export const askKindOf = closed<AskKind>('ask_kind', ['ask', 'challenge', 'other_side', 'about', 'mention']);
export const topicTagOf = closed<TopicTag>('tag', ['question', 'debate', 'explainer', 'share']);
export const summaryStateOf = closed<SummaryState>('state', ['queued', 'ready', 'declined', 'failed', 'stale']);

export const reviewStateOf = closed<ReviewState>('review_state', ['pending', 'approved', 'rejected', 'superseded']);
export const attemptStateOf = closed<BackdropAttemptState>('state', [
  'dispatched',
  'succeeded',
  'failed',
  'not_sent',
  'unknown',
  'reconciled',
  'written_off',
]);
export const imageMimeOf = closed<'image/jpeg' | 'image/png' | 'image/webp'>('mime', [
  'image/jpeg',
  'image/png',
  'image/webp',
]);
