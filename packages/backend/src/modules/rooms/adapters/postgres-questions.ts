import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { UnnoticedQuestion } from '../application/question-ports.js';
import type { QuestionStore } from '../application/ports.js';

const trxOf = (lock: Parameters<QuestionStore['waiting']>[0]) => sharedTransactionOf(lock.shared);

/** The most people's messages one question looks at to find who answered it first: a few, in case the first are people the asker blocked. */
const ANSWERERS_LOOKED_AT = 3;

/**
 * The notice state of the questions left for people (migration 0089). Every method is one explicit query inside the room's lock; none
 * decides access. Whether a question is still open is read from its messages, never stored: an answer that is removed, or whose
 * author deletes their account, reopens it without a write.
 */
export const questionStore: QuestionStore = {
  async waiting(lock) {
    const found = await sql<{ waiting: string }>`
      select count(*) as waiting from rooms.discussions question
      where question.room_id = ${lock.roomId}::uuid and question.tag = 'question'
        and question.started_by_account_id is not null
        and not exists (
          select 1 from rooms.messages answer
          where answer.discussion_id = question.discussion_id and answer.hidden_at is null
            and answer.author_account_id is not null
            and answer.author_account_id <> question.started_by_account_id)`.execute(trxOf(lock));
    return Number(found.rows[0]?.waiting ?? 0);
  },

  async unnoticed(lock, accountId, limit) {
    const found = await sql<{
      discussion_id: string;
      title: string;
      title_derived: boolean;
      asked_at: Date | string;
      author_account_id: string;
      recorded_at: Date | string;
    }>`
      select question.discussion_id, question.title, question.title_derived, question.created_at as asked_at,
        answer.author_account_id,
        answer.recorded_at
      from (
        select asked.discussion_id, asked.title, asked.title_derived, asked.created_at, asked.last_activity_at,
          asked.started_by_account_id
        from rooms.discussions asked
        where asked.room_id = ${lock.roomId}::uuid and asked.tag = 'question'
          and asked.started_by_account_id = ${accountId}::uuid
          and asked.notify_answer and asked.answer_noticed_at is null
          and exists (
            select 1 from rooms.messages other
            where other.discussion_id = asked.discussion_id and other.hidden_at is null
              and other.author_account_id is not null and other.author_account_id <> asked.started_by_account_id)
        order by asked.last_activity_at desc, asked.discussion_id desc limit ${limit}
      ) question
      cross join lateral (
        select message.author_account_id, message.recorded_at, message.sequence from rooms.messages message
        where message.discussion_id = question.discussion_id and message.hidden_at is null
          and message.author_account_id is not null and message.author_account_id <> question.started_by_account_id
        order by message.sequence limit ${ANSWERERS_LOOKED_AT}
      ) answer
      order by question.last_activity_at desc, question.discussion_id desc, answer.sequence`.execute(trxOf(lock));
    const byQuestion = new Map<
      string,
      { title: string; titleDerived: boolean; askedAt: Date; answerers: UnnoticedQuestion['answerers'][number][] }
    >();
    for (const row of found.rows) {
      const entry = byQuestion.get(row.discussion_id) ?? {
        title: row.title,
        titleDerived: row.title_derived,
        askedAt: new Date(row.asked_at),
        answerers: [],
      };
      entry.answerers.push({ accountId: row.author_account_id, recordedAt: new Date(row.recorded_at) });
      byQuestion.set(row.discussion_id, entry);
    }
    return [...byQuestion].map(([discussionId, entry]) => ({ discussionId, ...entry }));
  },

  async setNotice(lock, input) {
    const updated = await trxOf(lock)
      .updateTable('rooms.discussions')
      .set({
        ...(input.notify === undefined ? {} : { notify_answer: input.notify }),
        ...(input.noticedAt === undefined ? {} : { answer_noticed_at: input.noticedAt }),
      })
      .where('room_id', '=', lock.roomId)
      .where('discussion_id', '=', input.discussionId)
      .where('tag', '=', 'question')
      .where('started_by_account_id', '=', input.accountId)
      .returning('notify_answer')
      .executeTakeFirst();
    return updated === undefined ? undefined : { notify: updated.notify_answer };
  },
};
