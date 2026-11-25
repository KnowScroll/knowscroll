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
 * The drawing kits a stored v2 Scroll's pinned picture can be made from. A recipe named a kit only where that kit drew what the recipe
 * was about (D-125, D-194, D-201, D-204); none does since #787, and the plan field is deleted (#815). `scroll-model` owns the kits
 * themselves and derives the legacy stage of a deleted kit from this list; a test keeps the two in step.
 */
export const STAGE_KIT_IDS = ['earth-sky.v1'] as const;

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
  /** Angle, what to explain and what to avoid. */
  readonly brief: string;
  /** One to three allowlisted public pages the writer may draw on. */
  readonly pages: readonly string[];
  /** Cutroom script name of the matching approved Reel, for the original three recipes only. */
  readonly script?: string;
  /**
   * Present when this recipe is produced as a `scroll-document.v3` (sections of beats and pictures from the closed set). A person decides it, per
   * recipe (#771); the 22 recipes that had a drawing kit carry it since #787 and every other recipe since #790.
   */
  readonly scrollV3?: ScrollV3Plan;
};

/**
 * The common wrong idea a Scroll teaches against, with the label of the source that says it is common, or `none` for a narrative
 * Scroll. Structurally scroll-model's `Misconception`. A label counts only once a person has `reviewed` it against its source; the
 * library admits no other.
 */
export type PlanMisconception =
  | {
      readonly kind: 'myth';
      readonly claim: string;
      readonly source: { readonly label: string; readonly reviewed: boolean };
    }
  | { readonly kind: 'none' };

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
  /** The common wrong idea the Scroll teaches against, or `none`. */
  readonly misconception: PlanMisconception;
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
