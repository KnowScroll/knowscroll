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
export type SceneFamilyName = 'terraced.v1' | 'ridged.v1' | 'archipelago.v1';

/** A kind of angle on a topic (mechanism, example, limitation...), written as a topic-specific id. */
export interface LibraryFacet {
  readonly id: string;
  readonly meaning: string;
}

/** A planet: an explored subtopic. Needs at least three recipes over at least two facets to form. */
export interface LibraryTopic {
  readonly id: string;
  readonly meaning: string;
  /** Overrides the system's family for this planet. Its regions inherit it. */
  readonly sceneFamily?: SceneFamilyName;
  readonly facets: readonly LibraryFacet[];
}

/** A broad domain: the container for related planets and their organising star. */
export interface LibrarySystem {
  readonly id: string;
  readonly meaning: string;
  /** The family of the system and its star, and the default for its planets. */
  readonly sceneFamily: SceneFamilyName;
  readonly topics: readonly LibraryTopic[];
}

/**
 * The drawing kits a Scroll's pinned picture can be made from. A kit draws one family of subjects, and a
 * recipe names a kit only where that kit draws what the recipe is about (D-125). `scroll-model` owns
 * the kits themselves; this list names them for the plan, and a test keeps the two in step.
 */
export const STAGE_KIT_IDS = ['earth-sky.v1'] as const;
export type StageKitId = (typeof STAGE_KIT_IDS)[number];

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
   * a pinned picture). Every other recipe stays a v1 Scroll. A person decides it, per recipe: the writer
   * and the system never do (D-129).
   */
  readonly scrollV2?: ScrollV2Plan;
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
