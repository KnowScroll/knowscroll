import { ASIDE_KINDS, STOP_EMPHASES } from '../../v2/document.js';
import { EARTH_SKY_KIT } from '../../v2/kit.js';
import { kitDefinition, kitKeys, type StageKitId } from '../../v2/kits/index.js';
import { LIMITS_V2 as L } from '../../v2/limits.js';
import { GUIDE_POSES, type GuideCharacter, type InteractiveKind } from '../../v2/blocks.js';

/**
 * One line of reference for each play block a recipe names (D-207). Every example is invented syntax over
 * an invented subject. The stop around a block keeps the stop fields (cites, text, simple, stage); only what
 * the block adds is shown.
 */
const BLOCK_REFERENCE: Readonly<Record<InteractiveKind, string>> = {
  sort: `sort: {"type":"sort","cites":["e2"],"text":"A lead-in that asks the reader to put steps in order.","simple":"…","items":["First step","Second step","Third step"],"explain":"Why it goes in this order, at most ${L.stopWords} words."}  (${L.sortItems.min} to ${L.sortItems.max} short items, written in the CORRECT order: code shuffles them for the reader and keeps your order as the answer. Items must be steps or things the passages put in a clear order.)`,
  fork: `fork: {"type":"fork","cites":["e2"],"text":"A lead-in.","simple":"…","prompt":"Which way do you want to look?","branches":[{"label":"Short label","text":"What this path says, at most ${L.branchWords} words."},{"label":"Other label","text":"What the other path says."}]}  (exactly two paths, both worth reading, each a different angle on the same idea; the reader picks one and may read the other afterwards. Both rejoin at the next stop, so neither may be needed to understand it.)`,
  scale: `scale: {"type":"scale","cites":["e2"],"text":"A lead-in.","simple":"…","axis":"linear" | "log","unit":"kilometres","points":[{"label":"Earth","value":"150","magnitude":"million"},{"label":"Mars","value":"228","magnitude":"million"},{"label":"Jupiter","value":"779","magnitude":"million"}],"here":"Earth"}  (${L.scalePoints.min} to ${L.scalePoints.max} points on one unit; "log" when the values differ by factors of ten or more. EVERY value is a figure a cited passage states, written as that passage writes it; when the passage writes "4 million", give "value":"4" and "magnitude":"million" (also thousand, billion, trillion), and the unit is what is counted, in words a cited passage uses ("kilometres", never "million km"). "here" is the label of the point the reader should place themselves at. Never a value the passages do not state.)`,
  chart: `chart: {"type":"chart","cites":["e2"],"text":"A lead-in.","simple":"…","shape":"bars" | "line","unit":"operations","points":[{"label":"10 items","value":"100"},{"label":"100 items","value":"10,000"},{"label":"1,000 items","value":"1,000,000"}]}  (${L.chartPoints.min} to ${L.chartPoints.max} points in the order they should appear; the reader reveals them one by one, so the order tells a story. EVERY value is a figure a cited passage states, written as that passage writes it; when the passage writes "8.3 million", give "value":"8.3" and "magnitude":"million", and the unit is what is counted, in words a cited passage uses. Never a value the passages do not state.)`,
};

/**
 * The writer-facing description of `scroll-authoring.v2`. Limits and kit values come from the same
 * tables the schema and the checks use, so the prompt cannot drift from what is enforced. Every
 * example is invented syntax guidance about an invented subject: never evidence, never content.
 */
export function authoringReferenceV2(
  variant: 'stage' | 'plain',
  kitId: StageKitId = EARTH_SKY_KIT,
  blocks: readonly InteractiveKind[] = [],
  guide?: GuideCharacter,
): string {
  const kit = kitDefinition(kitId);
  const stageLine =
    variant === 'stage'
      ? `  "stage": optional object on a stop (never on a call_it or the final_call), only the values that change here; the rest carry over from the item before. Keys and allowed words:\n${kitKeys(
          kit,
        )
          .map((key) => `    ${key}: ${(kit.enums[key] ?? []).join(' | ')}`)
          .join(
            '\n',
          )}\n  The first stop sets the starting picture. Never write a number or a place name in "stage". Code draws everything else from these words.`
      : '';
  return [
    `Top level: {"title":"…","dek":"…","items":[item, …],"recap":{"cites":["e1"],"captions":["…","…","…"]},"askSuggestions":["…?","…?","…?"]}`,
    `items is one flat list in reading order. Each item has a "type". A stop's text and line together are at most ${L.stopWords} words.`,
    `stop: {"type":"stop","cites":["e2"],"text":"One idea.","line":"Optional short line of at most ${L.lineWords} words.","heading":"Optional, rare","emphasis":"${STOP_EMPHASES.join('" | "')}","simple":"The same idea in plainer, shorter words."${variant === 'stage' ? ',"stage":{…}' : ''}}`,
    `call_it: {"type":"call_it","cites":["e3"],"prompt":"A question the reader answers before they know.","options":["The correct option FIRST","A wrong option","A second wrong option"],"explain":"Why the answer is what it is, at most ${L.stopWords} words.","twist":"What a wrong pick reads: warm, no blame, at most ${L.stopWords} words.","simple":"…"}  (${L.optionsPerCall.min} or ${L.optionsPerCall.max} options. The correct option is always FIRST: code shuffles them. In the first call_it of a Scroll that names a misconception, the SECOND option is the wrong option that states it: code marks it as the common guess, so there is nothing to number.)`,
    `final_call: {"type":"final_call","cites":["e4"],"prompt":"…","options":["Correct FIRST","Wrong"],"explain":"…","twist":"…","simple":"…"}  (exactly one, the last item; it asks the reader to use the whole idea in a new case, never to repeat an earlier call)`,
    `aside: {"type":"aside","cites":["e5"],"kind":"${ASIDE_KINDS.join('" | "')}","title":"Where this stops","text":"At most ${L.stopWords} words.","collapsed":false}  (belongs to the stop or call just BEFORE it in the list; write it right after that item)`,
    ...blocks.map((kind) => BLOCK_REFERENCE[kind]),
    ...(guide === undefined
      ? []
      : [
          `guide: an optional member of a "stop" item: "guide":{"pose":"${GUIDE_POSES.join('" | "')}","line":"At most ${L.guideWords} words, in the guide's voice."}  (at most ${L.guides} in the Scroll, with two stops at least between lines.)`,
        ]),
    stageLine,
    `recap: three short captions of at most 100 characters that restate the idea in order. askSuggestions: ${L.askSuggestions} questions a curious reader would ask next, each a full question.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
