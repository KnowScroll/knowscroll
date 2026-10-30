import { z } from 'zod';
import { defineQueue } from '../../infrastructure/jobs/queues.js';

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
    // Two attempts at the largest configurable provider deadline (300 s) plus quota and lock waits
    // (reasoning/README: 2 x (10 + 300 + 10) + 30), rounded up.
    expireInSeconds: 700,
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
    // As rooms.contribute: two attempts at the largest provider deadline plus quota and lock waits.
    expireInSeconds: 700,
    retryLimit: 2,
    retryDelaySeconds: 15,
    retryBackoff: true,
    retentionSeconds: 3 * 86400,
    deleteAfterSeconds: 86400,
    deadLetter: true,
  },
  consumer: { localConcurrency: 2, pollingIntervalSeconds: 1 },
});
