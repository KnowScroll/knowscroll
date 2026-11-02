import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';
import { ANSWER_CLAIM_SECONDS } from './domain/answer-support.js';

/**
 * One member's ask of an AI inhabitant. IDs only: the worker rechecks the asker's universe and epoch,
 * that they are still a member of an open room and that the ask is still queued before it reads the
 * discussion, so a late or duplicate delivery changes nothing.
 */
export const ContributeJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  requestId: z.uuid(),
});
export type ContributeJob = z.infer<typeof ContributeJobSchema>;

export const contributeQueue = defineQueue({
  name: 'rooms.contribute',
  purpose: 'Let one labelled AI inhabitant answer a member who asked, within the room and daily bounds.',
  payload: ContributeJobSchema,
  policy: {
    // Every paid attempt of an answer at the largest provider deadline (300 s) plus quota and lock waits, one after the other
    // (reasoning/README: 6 x (10 + 300 + 10) + 30, D-303).
    expireInSeconds: ANSWER_CLAIM_SECONDS,
    retryLimit: 2,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});

const SpeechTriggerSchema = z.enum(['unanswered_question', 'overstated_claim', 'answer_overstated']);

/** How many times one check may look again before it is let go. */
export const CAST_DUE_ROUNDS = 24;

/**
 * The check that decides whether a resident answers one message, to run once the wait people are owed is over
 * (D-164). IDs only. The worker acts for the universe of the person whose message set it off, only to take the room
 * lock in the order the blueprint requires and to stop when that person is gone; the model call that may follow is
 * paid by the room scope, not by them. `round` counts how many times the check looked again (a typing hold, a wait
 * that grew); it never looks again more than `CAST_DUE_ROUNDS` times.
 */
export const CastDueJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  roomId: z.uuid(),
  discussionId: z.uuid(),
  causeMessageId: z.uuid(),
  trigger: SpeechTriggerSchema,
  round: z.number().int().min(0).max(CAST_DUE_ROUNDS),
});
export type CastDueJob = z.infer<typeof CastDueJobSchema>;

export const castDueQueue = defineQueue({
  name: 'rooms.cast-due',
  purpose: 'Decide, once the wait people are owed is over, whether a resident answers a message, within the caps.',
  payload: CastDueJobSchema,
  policy: {
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 2 },
});

/** How many times posting an allowed turn may be put off because someone is typing. */
export const CAST_PASS_ROUNDS = 3;

/**
 * The model call of one allowed unprompted turn. IDs only. As for `rooms.contribute`, the worker rechecks that the
 * room is open, the turn is still queued and nobody has answered before it posts anything. `round` counts how many
 * times posting was put off because someone was typing.
 */
export const CastPassJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  roomId: z.uuid(),
  turnId: z.uuid(),
  round: z.number().int().min(0).max(CAST_PASS_ROUNDS),
});
export type CastPassJob = z.infer<typeof CastPassJobSchema>;

export const castPassQueue = defineQueue({
  name: 'rooms.cast-pass',
  purpose: 'Let one resident answer on its own, once the router allowed the turn, under the room reasoning scope.',
  payload: CastPassJobSchema,
  policy: {
    // As rooms.contribute: every paid attempt of an answer at the largest provider deadline plus quota and lock waits.
    expireInSeconds: ANSWER_CLAIM_SECONDS,
    retryLimit: 2,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});

/**
 * The model call that writes one window's "while you were away" (D-169). IDs only. The worker acts for the universe of
 * the member whose return opened the window, only to take the room lock in order and to stop when that person is gone;
 * the call itself is paid by the room scope. A redelivery finds the summary settled and does nothing.
 */
export const SummariseJobSchema = z.strictObject({
  v: z.literal(1),
  universeId: z.uuid(),
  privacyEpoch: z.number().int().positive(),
  roomId: z.uuid(),
  summaryId: z.uuid(),
});
export type SummariseJob = z.infer<typeof SummariseJobSchema>;

export const summariseQueue = defineQueue({
  name: 'rooms.summarise',
  purpose: "Let a resident write one window's 'while you were away' for a room, under the room reasoning scope.",
  payload: SummariseJobSchema,
  policy: {
    // As rooms.cast-pass: two attempts at the largest provider deadline plus quota and lock waits.
    expireInSeconds: 700,
    retryLimit: 2,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 2 },
});

/**
 * Once a night: drafts the day's question and Spot the flaw for every open room that has a member (D-176). No payload but
 * its version: the rooms and the day are read when it runs. A room's items are unique by (room, day, kind) and the model run
 * is fixed by the room and day, so a late, repeated or retried delivery changes nothing and pays for nothing twice. What it
 * drafts waits for an operator; nothing here shows a member anything.
 */
export const NightlyRitualsJobSchema = z.strictObject({ v: z.literal(1) });
export type NightlyRitualsJob = z.infer<typeof NightlyRitualsJobSchema>;

export const nightlyRitualsQueue = defineQueue({
  name: 'rooms.nightly-rituals',
  purpose: "Draft each room's daily question and Spot the flaw from the library, for an operator to approve.",
  payload: NightlyRitualsJobSchema,
  policy: {
    // One call per room, each up to two attempts at the largest provider deadline: an hour covers a dozen rooms.
    expireInSeconds: 3600,
    retryLimit: 2,
    retryDelaySeconds: 300,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '10 3 * * *', payload: { v: 1 } },
});

/**
 * The residents' heartbeat (v3 R-8, D-248): three times a day, at the start of each 8-hour UTC slot, every open room that has a
 * resident and someone listening gets one look. A look writes the room's memory again when it is due and posts a find about a
 * library asset the room has not seen when a resident's rest is over and the caps allow it; a room with nothing new, nothing due
 * and nobody listening costs no model call. No payload but its version: the rooms are read when it runs. Every turn a look makes is
 * unique by (room, kind, slot), and the model run's ID is fixed by it, so a late, repeated or retried delivery changes nothing and
 * pays for nothing twice. Nothing here names a person or a universe.
 */
export const FeedHeartbeatJobSchema = z.strictObject({ v: z.literal(1) });
export type FeedHeartbeatJob = z.infer<typeof FeedHeartbeatJobSchema>;

/**
 * The scouts' heartbeat (v3 R-9, D-259): every scout that may post gets one look, on the residents' rhythm but a little after it.
 * IDs only; the job carries nothing of any member.
 */
export const ScoutHeartbeatJobSchema = z.strictObject({ v: z.literal(1) });
export type ScoutHeartbeatJob = z.infer<typeof ScoutHeartbeatJobSchema>;

export const scoutHeartbeatQueue = defineQueue({
  name: 'rooms.scout-heartbeat',
  purpose: "Let each member's scout look in the library for one find for the room it was sent to.",
  payload: ScoutHeartbeatJobSchema,
  policy: {
    // One call a scout, each up to two attempts at the largest provider deadline: three hours cover a handful of scouts.
    expireInSeconds: 10_800,
    retryLimit: 2,
    retryDelaySeconds: 300,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '37 0,8,16 * * *', payload: { v: 1 } },
});

export const feedHeartbeatQueue = defineQueue({
  name: 'rooms.feed-heartbeat',
  purpose:
    "Let each room's residents look for something new in the library to post, and keep the room's memory current.",
  payload: FeedHeartbeatJobSchema,
  policy: {
    // Up to two calls a room, each up to two attempts at the largest provider deadline: three hours cover a handful of rooms.
    expireInSeconds: 10_800,
    retryLimit: 2,
    retryDelaySeconds: 300,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 30 },
  schedule: { cron: '7 0,8,16 * * *', payload: { v: 1 } },
});
