import { z } from 'zod';
import { isPublicLabel } from './sharing.js';

/**
 * A room's sky (v3 R-5, D-174 to D-176): the stars a room earns together, the constellation seven of them make, and the
 * name the room gives it. A star is a moment the room made, not something a person owns: it names an act and a day and
 * never a person, a message, a title or a time of day. Only members read a room's sky; a block changes nothing in it.
 */

/** Seven stars make a constellation. */
export const ROOM_STARS_PER_CONSTELLATION = 7;
/** How long the room has to choose a constellation's name after its seventh star. */
export const ROOM_NAMING_HOURS = 24;
/** The longest a debate may run, in hours. */
export const ROOM_DEBATE_MAX_HOURS = 168;

/**
 * What earns a star (R3 E): a human answer marked Useful by someone else, a debate closed by vote, the day's Spot the
 * flaw found, and a Launch finished by at least two people (v3 R-6). An AI never earns one.
 */
export const RoomStarActSchema = z.enum(['answer_useful', 'debate_closed', 'daily_solved', 'launch_finished']);
export type RoomStarAct = z.infer<typeof RoomStarActSchema>;

const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ConstellationNameSchema = z.string().min(1).max(40).refine(isPublicLabel);

/**
 * The sky as a station draws it: `lit` stars of `of` in the constellation being made now, how many constellations the room
 * has finished, and where that one is. `forming` has fewer than seven; `naming` has seven and a vote open; `named` has
 * seven and a name. `constellationName` is the room's latest chosen name, so a station keeps its name while the next
 * constellation forms. A room that has finished one glows (`finished` of one or more) whatever it is making next.
 */
export const RoomSkySchema = z
  .strictObject({
    lit: z.number().int().min(0).max(ROOM_STARS_PER_CONSTELLATION),
    of: z.literal(ROOM_STARS_PER_CONSTELLATION),
    state: z.enum(['forming', 'naming', 'named']),
    finished: Counter,
    constellationName: ConstellationNameSchema.optional(),
  })
  .refine(
    (sky) =>
      (sky.state === 'forming' ? sky.lit < ROOM_STARS_PER_CONSTELLATION : sky.lit === ROOM_STARS_PER_CONSTELLATION) &&
      (sky.state === 'forming' || sky.finished >= 1) &&
      (sky.state !== 'named' || sky.constellationName !== undefined),
  );
export type RoomSky = z.infer<typeof RoomSkySchema>;

/** One star, for a member who taps it: the act, the UTC day and the constellation it belongs to. */
export const RoomStarSchema = z.strictObject({
  act: RoomStarActSchema,
  day: z.iso.date(),
  constellation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type RoomStar = z.infer<typeof RoomStarSchema>;

/**
 * The name vote of a finished constellation: three names from code word lists and when the vote closes. Counts per name
 * appear only to a member who has voted (`yourVote`), as for a poll, and never say who chose what.
 */
export const RoomNamingSchema = z
  .strictObject({
    constellation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    candidates: z.tuple([ConstellationNameSchema, ConstellationNameSchema, ConstellationNameSchema]),
    closesAt: z.iso.datetime(),
    yourVote: z.number().int().min(0).max(2).optional(),
    votes: z.tuple([Counter, Counter, Counter]).optional(),
  })
  // Counts are held back until the reader has voted, whatever a server or a client does.
  .refine((naming) => (naming.votes === undefined) === (naming.yourVote === undefined));
export type RoomNaming = z.infer<typeof RoomNamingSchema>;

/** One side of a debate and, once the reader has voted or the debate closed, how many chose it. */
const DebateSideSchema = z.strictObject({
  text: z.string().min(1).max(60).refine(isPublicLabel),
  votes: Counter.optional(),
});

/**
 * A debate on a topic (R3 B and E): two sides, a close time, and a vote a member may change until then. Tallies show to
 * a member who voted and to everyone once it closed; a tie has no winner. Closing it earns the room a star when at least
 * two different people voted.
 */
export const RoomDebateSchema = z
  .strictObject({
    sides: z.tuple([DebateSideSchema, DebateSideSchema]),
    closesAt: z.iso.datetime(),
    state: z.enum(['open', 'closed']),
    yourVote: z.enum(['a', 'b']).optional(),
    winner: z.enum(['a', 'b']).optional(),
  })
  // A tally shows (on both sides or neither) only to a reader who voted or once the debate closed; a winner only once it closed.
  .refine((debate) => {
    const counted = debate.sides.map((side) => side.votes !== undefined);
    const mayCount = debate.state === 'closed' || debate.yourVote !== undefined;
    return counted.every((has) => has === mayCount) && (debate.winner === undefined || debate.state === 'closed');
  });
export type RoomDebate = z.infer<typeof RoomDebateSchema>;

/** What a person starting a debate gives: two different short sides and how long it runs. */
export const NewDebateSchema = z
  .strictObject({
    sides: z.tuple([z.string().min(1).max(60).refine(isPublicLabel), z.string().min(1).max(60).refine(isPublicLabel)]),
    closesInHours: z.number().int().min(1).max(ROOM_DEBATE_MAX_HOURS),
  })
  .refine((debate) => debate.sides[0].toLowerCase() !== debate.sides[1].toLowerCase());
export type NewDebate = z.infer<typeof NewDebateSchema>;
