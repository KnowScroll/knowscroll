/**
 * The rows of a question left for people (migration 0089, D-242) as the use cases read them. The store that reads and writes them is
 * `QuestionStore` in `ports.ts`, with the room's other stores. A question is a topic tagged `question`; what is new is only the
 * starter's notice state.
 */

/** One of the caller's own questions that a person has answered and the caller has not noticed, with the first people who spoke in it. */
export interface UnnoticedQuestion {
  readonly discussionId: string;
  readonly title: string;
  /** When the question was left. */
  readonly askedAt: Date;
  /** Persons other than the asker whose shown messages are in it, oldest first (at most three). Their accounts, not yet checked against blocks. */
  readonly answerers: readonly { readonly accountId: string; readonly recordedAt: Date }[];
}
