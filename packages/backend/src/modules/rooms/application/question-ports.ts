/**
 * The rows of a question left for people (migration 0089, D-242) as the use cases read them. The store that reads and writes them is
 * `QuestionStore` in `ports.ts`, with the room's other stores. A question is a topic tagged `question`; what is new is only the
 * starter's notice state.
 */

/** One of the caller's own questions that a person has answered and the caller has not noticed, with the first person who spoke in it. */
export interface UnnoticedQuestion {
  readonly discussionId: string;
  readonly title: string;
  /** The title is the first words of its first message, so it is read only as `titlesFor` allows (D-168). */
  readonly titleDerived: boolean;
  /** When the question was left. */
  readonly askedAt: Date;
  /** The first person other than the asker, and not among the accounts the query was told to skip, whose shown message is in it. */
  readonly answerer: { readonly accountId: string; readonly recordedAt: Date };
}
