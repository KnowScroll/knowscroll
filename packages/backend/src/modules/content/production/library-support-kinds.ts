import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION, SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { LIBRARY_SUPPORT_CHECK_VERSION } from './library-support.js';
import { LIBRARY_SUPPORT_V3_CHECK_VERSION } from './library-support-v3.js';
import { scrollV3PlanOf } from './topics.js';

/**
 * Which support check reads which document (D-435). A stored result is keyed by the checker's version, and the version is the document version's own: a
 * stored document v2 is read by the v2 check (D-415), a stored document v3 by the v3 check. The release policy, the sweep, the job and the replay ask
 * this one place, so none of them can read a v3 under the v2 version or the other way round.
 */

/** The checker version of each document version a check reads. */
export const LIBRARY_CHECKER_VERSIONS = {
  v2: LIBRARY_SUPPORT_CHECK_VERSION,
  v3: LIBRARY_SUPPORT_V3_CHECK_VERSION,
} as const;

/** Every checker version of this build, for what must tell this build's results from any other's. */
export const LIBRARY_CHECKER_VERSION_LIST: readonly string[] = [
  LIBRARY_SUPPORT_CHECK_VERSION,
  LIBRARY_SUPPORT_V3_CHECK_VERSION,
];

/** The checker version for a stored revision's `document_version`, or `undefined` for a schema no library check reads (a v1 Scroll, a reel). */
export function checkerVersionOfDocument(documentVersion: string): string | undefined {
  if (documentVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION) return LIBRARY_SUPPORT_CHECK_VERSION;
  if (documentVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION) return LIBRARY_SUPPORT_V3_CHECK_VERSION;
  return undefined;
}

/**
 * The checker version for the Scroll a recipe's production job stores: the v3 check's for a recipe the plan marks `scrollV3`, the v2 check's
 * for every other. The delivery that held a revision knows its recipe and not yet the revision's document, so it asks here to send its check
 * at once under the version that reads what it stored (the sweep would find it anyway, up to ten minutes later).
 */
export function checkerVersionOfRecipe(recipeKey: string): string {
  return scrollV3PlanOf(recipeKey) === undefined ? LIBRARY_SUPPORT_CHECK_VERSION : LIBRARY_SUPPORT_V3_CHECK_VERSION;
}
