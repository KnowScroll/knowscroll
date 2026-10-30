import type { AskKind } from '../domain/asks.js';
import type { ContributionKind, InhabitantId } from '../domain/contribution.js';
import type { AiLevel, JoinRule, RoomRole, RoomStatus } from '../domain/membership.js';
import type { SpeechTrigger } from '../domain/triggers.js';
import type { SummaryState, TopicTag, TurnState, TurnTrigger } from '../application/ports.js';

/**
 * The text columns of migration 0062 are closed sets by CHECK constraints, but the generated row types
 * only know `string`. Each reader names the set once and refuses a value outside it, so a schema that
 * drifts fails loudly here instead of reaching a use case as an impossible value.
 */
function closed<T extends string>(column: string, values: readonly T[]): (value: string) => T {
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
]);
export const roleOf = closed<RoomRole>('role', ['member', 'moderator']);
export const aiLevelOf = closed<AiLevel>('ai_level', ['lively', 'quieter', 'off']);
export const discussionKindOf = closed<'general' | 'topic' | 'today'>('kind', ['general', 'topic', 'today']);
export const joinRuleOf = closed<JoinRule>('join_rule', ['open', 'friends_of_members', 'invite_only']);
export const statusOf = closed<RoomStatus>('status', ['open', 'paused', 'closed']);
export const topicKindOf = closed<'system' | 'planet'>('topic_kind', ['system', 'planet']);
export const endedByOf = closed<'left' | 'removed'>('ended_by', ['left', 'removed']);
export const turnStateOf = closed<TurnState>('state', ['queued', 'completed', 'declined', 'failed', 'refused']);
export const speechTriggerOf = closed<SpeechTrigger>('trigger', [
  'unanswered_question',
  'overstated_claim',
  'answer_overstated',
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
