import type { AuthoredScroll } from '@knowscroll/scroll-model/producer';

/**
 * The limits callout of the answer to a person's question is written by code (D-371). A sentence about what the answer cannot tell
 * is a claim about the answer itself, which no passage can support, so asking the support check to pass it asks for something that
 * cannot be met. Code puts one fixed line last instead. It claims nothing about the subject, only that the answer rests on the
 * library's sources and may not cover every case. Pure: no model, no clock. This is a leaf module so that the rest of the ask
 * code can tell code's callout from the writer's without importing one another.
 */

type AnswerBlock = AuthoredScroll['blocks'][number];
type CalloutBlock = Extract<AnswerBlock, { type: 'callout' }>;

/** The title of the callout, as the v3 design words the aside that says where an explanation stops. The client draws its "Limits" label. */
export const LIMITS_TITLE = 'Where this stops';

/** The one line the callout says. It names no subject and no source, and it is not checked against any passage. */
export const LIMITS_TEXT = "This answer uses only what the library's sources say. It may not cover every case.";

/** The authoring schema allows this many handles in one block's `cites`. */
const MOST_CITES = 12;

/** Whether a block is a callout of kind `limit`, whoever wrote it. */
export const isLimitsCallout = (block: AnswerBlock): block is CalloutBlock =>
  block.type === 'callout' && block.kind === 'limit';

/** Whether a block is the callout code wrote: a limits callout whose title and text are exactly the fixed ones. */
export const isCodeMadeLimits = (block: AnswerBlock | undefined): boolean =>
  block !== undefined && isLimitsCallout(block) && block.title === LIMITS_TITLE && block.text === LIMITS_TEXT;

/** Whether a block is a limits callout the writer wrote (any limits callout that is not exactly code's). */
export const isWritersLimits = (block: AnswerBlock): boolean => isLimitsCallout(block) && !isCodeMadeLimits(block);

/**
 * The blocks of an answer with every limits callout taken out and code's callout put last.
 *
 * The callout cites every passage the other blocks cite, as a title or a heading rests on whatever the answer cites, so it claims
 * no passage the answer does not already use. An answer whose blocks cite nothing gets no callout: it has no sentences to serve.
 *
 * @param blocks the blocks of the answer, in order
 * @param origin for each block, the index it had in the writer's draft
 * @param draftBlocks the number of blocks of the writer's draft; code's callout is located one past them
 */
export function closeWithCodeMadeLimits(
  blocks: readonly AnswerBlock[],
  origin: readonly number[],
  draftBlocks: number,
): { readonly blocks: readonly AnswerBlock[]; readonly origin: readonly number[] } {
  const kept = blocks.flatMap((block, index) => (isLimitsCallout(block) ? [] : [{ block, from: origin[index]! }]));
  const cites = [...new Set(kept.flatMap(({ block }) => ('cites' in block ? block.cites : [])))].slice(0, MOST_CITES);
  const closing: AnswerBlock[] =
    cites.length === 0 ? [] : [{ type: 'callout', cites, kind: 'limit', title: LIMITS_TITLE, text: LIMITS_TEXT }];
  return {
    blocks: [...kept.map(({ block }) => block), ...closing],
    origin: [...kept.map(({ from }) => from), ...closing.map(() => draftBlocks)],
  };
}
