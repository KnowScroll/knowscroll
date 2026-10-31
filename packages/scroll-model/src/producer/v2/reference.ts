import { ASIDE_KINDS, STOP_EMPHASES } from '../../v2/document.js';
import { EARTH_SKY_KIT } from '../../v2/kit.js';
import { kitDefinition, kitKeys, type StageKitId } from '../../v2/kits/index.js';
import { LIMITS_V2 as L } from '../../v2/limits.js';

/**
 * The writer-facing description of `scroll-authoring.v2`. Limits and kit values come from the same
 * tables the schema and the checks use, so the prompt cannot drift from what is enforced. Every
 * example is invented syntax guidance about an invented subject: never evidence, never content.
 */
export function authoringReferenceV2(variant: 'stage' | 'plain', kitId: StageKitId = EARTH_SKY_KIT): string {
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
    stageLine,
    `recap: three short captions of at most 100 characters that restate the idea in order. askSuggestions: ${L.askSuggestions} questions a curious reader would ask next, each a full question.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
