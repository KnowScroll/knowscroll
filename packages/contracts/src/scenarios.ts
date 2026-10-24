import { z } from 'zod';
import { plainText } from '@knowscroll/scroll-model';
import { ConversationScopeSchema } from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { PublicPersonRefSchema } from './sharing.js';
import { socialPost } from './social-problems.js';
import { ContentThreadRefSchema } from './threads.js';

/**
 * What if and Another perspective inside a content thread (blueprint §14, §17; D-049). A member
 * asks (a draft), may get a few directions back, and chooses one or submits their own complete
 * request; only the choice commissions a continuation. The branch then appears as a card in the
 * thread: preparing, then ready, or honestly unable to prepare. Nothing here carries a member's
 * position, current branch or seen marker.
 */
const Version = z.literal('scenario.v1');
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Most cards one list answers with. */
export const MAX_SCENARIO_CARDS = 100;
/** The member's own words for a request. */
export const MAX_SCENARIO_TEXT = 500;

/** One thing a branch holds true or changes: a short subject and a self-contained statement. */
export const AssumptionSchema = z.strictObject({ subject: plainText(2, 40), statement: plainText(3, 160) });
export type Assumption = z.infer<typeof AssumptionSchema>;

/**
 * One change of a direction. `replaces` names the premise of an earlier branch that this change takes the place
 * of, whatever its own subject says; absent, it replaces only a premise of its own subject.
 */
export const OptionChangeSchema = AssumptionSchema.extend({ replaces: plainText(2, 40).optional() });
export type OptionChange = z.infer<typeof OptionChangeSchema>;

export const ScenarioKindSchema = z.enum(['what_if', 'perspective']);
export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

/** The member's request in their words: one line, no control characters. */
const RequestText = z
  .string()
  .min(1)
  .max(MAX_SCENARIO_TEXT)
  .refine(
    (text) =>
      text.trim() === text &&
      [...text].every((character) => {
        const point = character.codePointAt(0)!;
        return point >= 32 && (point < 127 || point > 159);
      }),
  );

/** Where in the thread the request came from: the root encounter, or one message (a snippet is a message). */
export const ScenarioOriginRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('message'), messageId: UuidSchema }),
]);

/**
 * What the branch continues from, with the revision the member saw. The root's revision is the thread
 * root's asset revision; a node's is its card revision. A parent that moved since is stale.
 */
export const ScenarioParentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root'), assetRevision: Revision }),
  z.strictObject({ kind: z.literal('node'), nodeId: UuidSchema, revision: Revision }),
]);
export type ScenarioParent = z.infer<typeof ScenarioParentSchema>;

const Read = { version: Version, readId: UuidSchema };
const ScopedRead = { ...Read, scope: ConversationScopeSchema };
const Command = { version: Version, commandId: CommandIdSchema };
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
};

/**
 * Asks for directions. It stores the request and starts one bounded model step in a worker; it
 * commissions no content. A retry with the same command returns the same draft.
 */
export const StartScenarioDraftSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  kind: ScenarioKindSchema,
  origin: ScenarioOriginRequestSchema,
  parent: ScenarioParentSchema,
  text: RequestText,
});
export const ScenarioDraftStartedSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('scenario.draft'),
  draftId: UuidSchema,
});

/**
 * One direction. A what-if lists what it changes and what it keeps; a perspective names a lens and
 * changes nothing. `speculative` says the premise contradicts established knowledge; `needsConfirmation` says
 * the idea is unclear or speculative, so the screen shows the premise and asks before it commissions. A
 * speculative direction always needs confirming.
 */
export const ScenarioOptionSchema = z.strictObject({
  optionId: z.string().regex(/^o[1-3]$/),
  title: plainText(3, 120),
  explanation: plainText(3, 240),
  changes: z.array(OptionChangeSchema).max(2),
  kept: z.array(AssumptionSchema).max(3),
  lens: plainText(3, 80).optional(),
  speculative: z.boolean(),
  needsConfirmation: z.boolean(),
});
export type ScenarioOption = z.infer<typeof ScenarioOptionSchema>;

const DraftSummary = z.strictObject({
  draftId: UuidSchema,
  kind: ScenarioKindSchema,
  text: RequestText,
  createdAt: z.iso.datetime(),
});

export const ReadScenarioDraftSchema = z.strictObject({
  ...Read,
  thread: ContentThreadRefSchema,
  draftId: UuidSchema,
});
export const ScenarioDraftViewSchema = z.discriminatedUnion('status', [
  /** Not the requester's, expired, or the thread is no longer open to them. */
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({ ...ScopedRead, status: z.literal('thinking'), draft: DraftSummary }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    draft: DraftSummary,
    /** `direct`: the request is clear and `options` holds it as understood. `options`: a few directions to pick from. */
    mode: z.enum(['direct', 'options']),
    options: z.array(ScenarioOptionSchema).min(1).max(3),
  }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('failed'),
    draft: DraftSummary,
    reason: z.enum(['could_not_suggest', 'budget_unavailable']),
  }),
  z.strictObject({ ...ScopedRead, status: z.literal('chosen'), draft: DraftSummary, nodeId: UuidSchema }),
]);
export type ScenarioDraftView = z.infer<typeof ScenarioDraftViewSchema>;

/** A branch as a card in the thread. `startedBy` is absent once that member's account was deleted. */
export const ScenarioCardSchema = z.strictObject({
  nodeId: UuidSchema,
  kind: ScenarioKindSchema,
  origin: z.enum(['root', 'snippet', 'message']),
  originMessageId: UuidSchema.optional(),
  parentNodeId: UuidSchema.optional(),
  title: plainText(3, 120),
  changes: z.array(AssumptionSchema).max(2),
  kept: z.array(AssumptionSchema).max(3),
  lens: plainText(3, 80).optional(),
  /** Every what-if, and everything below one, is hypothetical. A perspective on the real subject is not. */
  hypothetical: z.boolean(),
  /**
   * The premise runs against established knowledge: the Planner said so of the direction and the member confirmed
   * it (an edit of that direction keeps the flag), or it continues a branch that does. Never set by a request
   * written from scratch.
   */
  speculative: z.boolean(),
  /** What holds after this branch: the premises a continuation of it inherits (at most four). */
  assumptions: z.array(AssumptionSchema).max(4),
  startedBy: PublicPersonRefSchema.optional(),
  status: z.enum(['preparing', 'ready', 'failed', 'removed']),
  /** Moves when the card's state does; a draft from this card names it as its parent revision. */
  revision: Revision,
  /** The admitted Scroll, once ready. */
  content: z
    .strictObject({
      kind: z.literal('scroll'),
      assetId: UuidSchema,
      assetRevision: Revision,
      title: z.string().min(1).max(240),
    })
    .optional(),
  createdAt: z.iso.datetime(),
});
export type ScenarioCard = z.infer<typeof ScenarioCardSchema>;

/**
 * The only command that commissions anything. `suggestion` takes one of the draft's stored
 * directions by its ID; `own` is the member's complete request, typed or edited: its changes and
 * kept statements, or a lens. An edit of one of the draft's directions names it in `fromOptionId`, and the
 * branch keeps that direction's `speculative` flag. A draft can be chosen once. The same command returns the
 * same card.
 */
export const ChooseScenarioSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  draftId: UuidSchema,
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('suggestion'), optionId: z.string().regex(/^o[1-3]$/) }),
    z.strictObject({
      kind: z.literal('own'),
      changes: z.array(AssumptionSchema).max(2),
      kept: z.array(AssumptionSchema).max(3),
      lens: plainText(3, 80).optional(),
      fromOptionId: z
        .string()
        .regex(/^o[1-3]$/)
        .optional(),
    }),
  ]),
});
export const ScenarioChoiceAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('scenario.choose'),
  node: ScenarioCardSchema,
  /** True when the thread already had this very branch: no second one is made. */
  reused: z.boolean(),
});

/**
 * A direction the Planner proposed to this member and that they have not made into a branch: a ready draft's
 * option, private to them, gone when the draft is (it lives two hours). It is not numbered and not a branch.
 */
export const ScenarioSuggestionSchema = z.strictObject({
  draftId: UuidSchema,
  optionId: z.string().regex(/^o[1-3]$/),
  kind: ScenarioKindSchema,
  /** The branch it would continue; absent when it continues the thread's root. */
  parentNodeId: UuidSchema.optional(),
  title: plainText(3, 120),
  speculative: z.boolean(),
});
export type ScenarioSuggestion = z.infer<typeof ScenarioSuggestionSchema>;
/** At most three kept drafts of three directions each. */
export const MAX_SCENARIO_SUGGESTIONS = 9;

export const ListScenariosSchema = z.strictObject({ ...Read, thread: ContentThreadRefSchema });
export const ScenarioListSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    cards: z.array(ScenarioCardSchema).max(MAX_SCENARIO_CARDS),
    /** The caller's own, never anyone else's. */
    suggestions: z.array(ScenarioSuggestionSchema).max(MAX_SCENARIO_SUGGESTIONS),
    /**
     * The branches whose Scroll this caller has opened ("Opened by you"), by card. The server derives it from the
     * caller's own exposures and answers it to the caller alone: a card never says that anyone else opened it.
     */
    opened: z.array(UuidSchema).max(MAX_SCENARIO_CARDS),
  }),
]);
export type ScenarioList = z.infer<typeof ScenarioListSchema>;

/** Takes a branch off the thread's cards. Only the member who started it can. Its Scroll is not deleted. */
export const RemoveScenarioSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  nodeId: UuidSchema,
  revision: Revision,
});
export const ScenarioRemovalAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('scenario.remove'),
  nodeId: UuidSchema,
  revision: Revision,
});

/** Served by the API's scenarios controller. Every command rechecks membership, the parent's revision and the day's budget. */
export const scenariosContract = {
  draft: socialPost('/v1/social/scenarios/draft', StartScenarioDraftSchema, ScenarioDraftStartedSchema),
  readDraft: socialPost('/v1/social/scenarios/draft/read', ReadScenarioDraftSchema, ScenarioDraftViewSchema),
  choose: socialPost('/v1/social/scenarios/choose', ChooseScenarioSchema, ScenarioChoiceAcceptanceSchema),
  list: socialPost('/v1/social/scenarios/list', ListScenariosSchema, ScenarioListSchema),
  remove: socialPost('/v1/social/scenarios/remove', RemoveScenarioSchema, ScenarioRemovalAcceptanceSchema),
};
