/**
 * Shapes of the library plan: the topic systems, planets and facets KnowScroll holds Scrolls for, and
 * the explanation recipes the generator runs. The plan is code-owned data. The shared concept
 * catalogue (`content-concepts.v1`) is derived from it, so a topic or facet exists only here.
 */

/** The block a recipe's interactive Scroll should prefer. Guidance for the writer, not a schema. */
export const INTERACTIVE_KINDS = ['simulation', 'diagram', 'chart', 'comparison', 'timeline', 'sequence'] as const;
export type InteractiveKind = (typeof INTERACTIVE_KINDS)[number];

/**
 * The silhouette family the Scene projection draws a system, star or planet with (D-026). It is a
 * cosmetic convention, not classification. Once an object has been drawn its family never changes,
 * so edit these for new systems and planets only.
 */
export const SCENE_FAMILY_NAMES = ['terraced.v1', 'ridged.v1', 'archipelago.v1'] as const;
export type SceneFamilyName = (typeof SCENE_FAMILY_NAMES)[number];

/**
 * The colour of the haze around a system's orange sun in the New Universe (D-077). Scenes keeps its
 * own list of the six and a test keeps the two in step.
 */
export const HAZE_FAMILY_NAMES = ['teal', 'cobalt', 'coral', 'amber', 'pink', 'violet'] as const;
export type HazeFamilyName = (typeof HAZE_FAMILY_NAMES)[number];

/**
 * Earlier wordings of a node's meaning that the current wording only rephrases (D-419). `content catalogue sync` reads it as the
 * author's declaration that certificates decided against the earlier wording stay valid; leave it out when the meaning
 * changes, and they do not. Code checks only that each text was a wording of the node; a person judges that nothing changed.
 */
export interface SameMeaning {
  readonly sameMeaningAs?: readonly string[];
}

/** A kind of angle on a topic (mechanism, example, limitation...), written as a topic-specific id. */
export interface LibraryFacet extends SameMeaning {
  readonly id: string;
  readonly meaning: string;
}

/** A planet: an explored subtopic. Needs at least three recipes over at least two facets to form. */
export interface LibraryTopic extends SameMeaning {
  readonly id: string;
  readonly meaning: string;
  /** Overrides the system's family for this planet. Its regions inherit it. */
  readonly sceneFamily?: SceneFamilyName;
  readonly facets: readonly LibraryFacet[];
}

/** A broad domain: the container for related planets and their organising star. */
export interface LibrarySystem extends SameMeaning {
  readonly id: string;
  readonly meaning: string;
  /**
   * The family of the system and its star, and the default for its planets. A new system may leave it out: it is then
   * assigned from its id, and repeats are allowed (D-419).
   */
  readonly sceneFamily?: SceneFamilyName;
  /**
   * The haze family of this system. Assigned once with the system's look and never changed, so edit it for new systems only
   * (D-102). A new system may leave it out: it is then assigned from its id, and repeats are allowed once the six are used (D-419).
   */
  readonly haze?: HazeFamilyName;
  readonly topics: readonly LibraryTopic[];
}

/**
 * The drawing kits a Scroll's pinned picture can be made from. A kit draws one family of subjects, and a
 * recipe named a kit only where that kit drew what the recipe is about (D-125, D-194, D-201, D-204); none does since #787.
 * `scroll-model` owns the kits themselves; this list names them for the plan, and a test keeps the two in step.
 */
export const STAGE_KIT_IDS = ['earth-sky.v1', 'starlight.v1', 'black-hole.v1'] as const;
export type StageKitId = (typeof STAGE_KIT_IDS)[number];

/**
 * The play blocks a v2 recipe may have besides its calls (D-207): a sort, a fork, a scale or a growing
 * chart. `scroll-model` owns the blocks; this list names them for the plan, and a test keeps the two in step.
 */
export const PLAY_BLOCK_KINDS = ['sort', 'fork', 'scale', 'chart'] as const;
export type PlayBlockKind = (typeof PLAY_BLOCK_KINDS)[number];

/** The characters that can guide a Scroll (D-207). Named here for the plan; a test keeps the list in step with `scroll-model`. */
export const GUIDE_CHARACTER_IDS = ['ray'] as const;
export type GuideCharacterId = (typeof GUIDE_CHARACTER_IDS)[number];

/**
 * The figures a recipe may ask the writer to put on its picture (D-382). `scroll-model` owns the slots; this list names them for the
 * plan, and a test keeps the two in step.
 */
export const STAGE_FIGURE_SLOT_IDS = ['nearest', 'farthest', 'june-daylight', 'december-daylight'] as const;
export type StageFigureSlotId = (typeof STAGE_FIGURE_SLOT_IDS)[number];

type Interactivity =
  | { readonly interactive: true; readonly interactiveKind: InteractiveKind }
  | { readonly interactive: false; readonly interactiveKind: null };

/**
 * One explanation unit the generator can write as a Scroll. The record key in the system file is the
 * stable operator key. Identity (`assetId`, `explanationUnitId`) never changes once a Scroll exists.
 */
export type LibraryRecipe<Topic extends string = string, Facet extends string = string> = Interactivity & {
  /** Stable explanation identity. Shared with a Reel only for the original three recipes. */
  readonly explanationUnitId: string;
  /** Stable asset UUID of the Scroll this recipe produces. */
  readonly assetId: string;
  readonly systemId: string;
  /** The planet this explanation counts toward. */
  readonly topicId: Topic;
  /** The angle this explanation teaches. */
  readonly facetId: Facet;
  /** A second angle the brief explicitly asks the closing section to cover. */
  readonly supportingFacetId?: Facet;
  /**
   * The kit that draws this recipe's subject, when one does. Only such a recipe gets a pinned picture
   * (a `stage` Scroll); every other recipe is a plain Scroll with calls and no picture, until a kit
   * exists for it. Deciding this is a person's job, per recipe, never the writer's or the system's.
   * No recipe names a kit since #787: the 22 recipes that had one are document v3 recipes, which have none. The field stays,
   * with the kit code, until the last kit is deleted (one kit at a time, after the owner reads that kit's rewrites).
   */
  readonly stageKit?: StageKitId;
  /** Angle, what to explain and what to avoid. */
  readonly brief: string;
  /** One to three allowlisted public pages the writer may draw on. */
  readonly pages: readonly string[];
  /** Cutroom script name of the matching approved Reel, for the original three recipes only. */
  readonly script?: string;
  /**
   * Present when this recipe is produced as a `scroll-document.v2` (stops, calls and, for a stage Scroll,
   * a pinned picture). No library recipe carries it since #790: every recipe is a document v3 recipe, and the v2 plan each had is kept
   * in `production/spike-v2/former-v2-plans.ts` for the v2 spike and the tests of the v2 path. A person decides it, per recipe: the writer
   * and the system never do (D-129).
   */
  readonly scrollV2?: ScrollV2Plan;
  /**
   * Present when this recipe is produced as a `scroll-document.v3` (sections of beats and pictures from the closed set). A recipe
   * carries `scrollV3` or `scrollV2`, never both (a library test), and a v3 recipe has no `stageKit`. A person decides it, per
   * recipe (#771); the 22 recipes that had a drawing kit carry it since #787 and every other recipe since #790.
   */
  readonly scrollV3?: ScrollV3Plan;
};

/** What the plan decides before the writer starts a v2 Scroll (`RecipeDataV2` in the producer). */
export interface ScrollV2Plan {
  /** `stage`: a pinned picture from a drawing kit; `plain`: stops and calls only. */
  readonly variant: 'stage' | 'plain';
  /**
   * The common wrong idea the first call tests, with the label of the source that says it is common,
   * or `none` for a narrative Scroll. Structurally scroll-model's `Misconception`. A label counts only
   * once a person has `reviewed` it against its source; the library admits no other.
   */
  readonly misconception:
    | {
        readonly kind: 'myth';
        readonly claim: string;
        readonly source: { readonly label: string; readonly reviewed: boolean };
      }
    | { readonly kind: 'none' };
  /**
   * What a locked Final call awards: a stable key (`the-leaning-axis`) and the name the reader sees.
   * Chosen by a person, per recipe, and set into the document by code; the writer never writes it.
   * Absent: the Scroll awards no landmark and the payoff shows none (D-188). Keys are unique in the library.
   */
  readonly landmark?: { readonly key: string; readonly name: string };
  /**
   * The control the Final call hands the reader on the stage. `tilt` turns Earth's axis and needs a
   * stage Scroll on the Earth & sky kit. Absent: the Final call is a plain call (D-187).
   */
  readonly finalCall?: { readonly kind: 'tilt' };
  /**
   * The play blocks the Scroll has, each used once and at most two in all (D-207). The pages must state the
   * figures a scale or a chart shows, and the order a sort asks for. Chosen by a person, per recipe; the
   * writer is told which blocks to write and never adds one. Absent: the Scroll has calls only.
   */
  readonly blocks?: readonly PlayBlockKind[];
  /** The character that speaks the Scroll's guide lines. Absent: no guide (D-207). Chosen by a person, per recipe. */
  readonly guide?: GuideCharacterId;
  /**
   * What the recipe asks of its picture beyond the kit's words (D-382, D-383), for a stage Scroll drawn with Earth & sky. The writer
   * is told what is asked and code proves it, never the other way round. Chosen by a person, per recipe.
   */
  readonly stagePlan?: {
    /** The picture stands on Earth's orbit at this many different months at least, so the recap of the journey draws (D-368). */
    readonly orbitMonths?: number;
    /** Figures the writer is asked for where a cited passage states them; code leaves out any no passage states. */
    readonly figures?: readonly StageFigureSlotId[];
    /** The first call_it shows the true picture to a reader who guessed wrong: the stop after it sets that picture. */
    readonly reveal?: boolean;
  };
}

/** The kinds of picture a document v3 draws: scroll-model's `PICTURE_KINDS` (a library test keeps the two in step). */
export const PICTURE_KIND_IDS = ['statement', 'flow', 'cycle', 'grid', 'chart', 'plan'] as const;
export type PictureKindId = (typeof PICTURE_KIND_IDS)[number];

/** The kinds of essay a document v3 is: scroll-model's `SCROLL_SHAPES` (a library test keeps the two in step). */
export const SCROLL_SHAPE_IDS = ['argument', 'mechanism', 'story'] as const;
export type ScrollShapeId = (typeof SCROLL_SHAPE_IDS)[number];

/**
 * What the plan decides before the writer starts a `scroll-document.v3` Scroll (#771, decisions 2 and 4): the kind of essay,
 * what each of its two or three sections is for and, when a person chose them, its pictures by kind and purpose. The writer
 * fills a picture's labels, notes and cited values; code assigns every id. Without `pictures` the writer picks kinds from the
 * closed set by what its passages hold, and a statement picture is always available.
 */
export interface ScrollV3Plan {
  readonly shape: ScrollShapeId;
  /** One short line per section, in reading order: two or three. */
  readonly sections: readonly string[];
  /** One to three pictures, each a kind and what it is there to show. */
  readonly pictures?: readonly { readonly kind: PictureKindId; readonly purpose: string }[];
  /** As for v2: the common wrong idea the Scroll teaches against, or `none`. */
  readonly misconception: ScrollV2Plan['misconception'];
}

/**
 * The recipes of one system file. The topic and facet ids a recipe may name are typed from the
 * system's own plan, so a misspelt id fails to compile. That a facet belongs to the recipe's topic
 * is checked by the library tests.
 */
export type SystemRecipes<S extends LibrarySystem> = Record<
  string,
  LibraryRecipe<S['topics'][number]['id'], S['topics'][number]['facets'][number]['id']>
>;
