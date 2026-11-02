import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { FLAIR_NEEDED, type FlairChoice, type FlairKind } from '../domain/flair.js';
import type { FlairStore } from '../application/ports.js';

const trxOf = (lock: Parameters<FlairStore['choose']>[0]) => sharedTransactionOf(lock.shared);

const CHOICES: ReadonlySet<string> = new Set([
  'none',
  'first_answer',
  'good_question',
  'flaw_finder',
  'launch_regular',
]);

/** The stored choice as the rules read it: a closed value or none (automatic). A value the check would refuse never reads as one. */
const choiceOf = (value: string | null): FlairChoice =>
  value !== null && CHOICES.has(value) ? (value as FlairKind | 'none') : null;

/**
 * Flair's reads (migration 0102). A member's flair is four counts over rows that exist, so a Clear, leaving, removal and an
 * account deletion take it with the rows they already erase and nothing here has to remember to forget. Each count is a
 * subquery bounded by what its mark needs (`limit`), so a person who did far more costs no more to read. An AI inhabitant, a
 * scout and a resident have no account on any of these rows, so none of them is ever a member counted here.
 *
 * - answers: words by a person in Today, or in a question topic someone else left (D-174's first act, without the mark).
 * - good questions: question topics the member left whose first message another member marked Useful.
 * - flaws found: their right taps on Spot the flaw.
 * - launches played: finished Launches they answered in, among the ones whose answers are still kept (D-220).
 */
export const flairStore: FlairStore = {
  async membersOf(lock, accountIds, options) {
    if (accountIds.length === 0) return [];
    const needed = FLAIR_NEEDED;
    const rows = await sql<{
      account_id: string;
      flair_choice: string | null;
      answers: string;
      good_questions: string;
      flaws_found: string;
      launches_played: string;
    }>`
      select member.account_id, member.flair_choice,
        (select count(*) from (
          select 1 from rooms.messages message
          join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
          where discussion.room_id = member.room_id
            and message.author_account_id = member.account_id and message.author_kind = 'person'
            and message.body_text is not null and message.hidden_at is null
            and (discussion.kind = 'today'
              or (discussion.tag = 'question' and discussion.started_by_account_id is distinct from member.account_id))
          limit ${needed.first_answer}) counted) as answers,
        (select count(*) from (
          select 1 from rooms.discussions question
          join rooms.messages opening on opening.discussion_id = question.discussion_id and opening.sequence = 1
            and opening.author_account_id = question.started_by_account_id and opening.hidden_at is null
          where question.room_id = member.room_id and question.tag = 'question'
            and question.started_by_account_id = member.account_id
            and exists (select 1 from rooms.message_useful mark where mark.message_id = opening.message_id)
          limit ${needed.good_question}) counted) as good_questions,
        (select count(*) from (
          select 1 from rooms.ritual_solves solve
          join rooms.rituals ritual on ritual.ritual_id = solve.ritual_id
          where solve.account_id = member.account_id and solve.correct and ritual.room_id = member.room_id
          limit ${needed.flaw_finder}) counted) as flaws_found,
        (select count(*) from (
          select answer.launch_id from rooms.launch_answers answer
          join rooms.launches launch on launch.launch_id = answer.launch_id
          where answer.account_id = member.account_id and launch.room_id = member.room_id and launch.state = 'finished'
          group by answer.launch_id
          limit ${needed.launch_regular}) counted) as launches_played
      from rooms.members member
      where member.room_id = ${lock.roomId}::uuid and member.ended_at is null
        and member.account_id = any(${[...accountIds]}::uuid[])
        and (${!options.shownOnly} or member.flair_choice is distinct from 'none')`.execute(trxOf(lock));
    return rows.rows.map((row) => ({
      accountId: row.account_id,
      choice: choiceOf(row.flair_choice),
      acts: {
        answers: Number(row.answers),
        goodQuestions: Number(row.good_questions),
        flawsFound: Number(row.flaws_found),
        launchesPlayed: Number(row.launches_played),
      },
    }));
  },

  async choose(lock, accountId, choice) {
    await trxOf(lock)
      .updateTable('rooms.members')
      .set({ flair_choice: choice })
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .where('ended_at', 'is', null)
      .execute();
  },
};
