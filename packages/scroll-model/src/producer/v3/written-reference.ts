import { ASIDE_KINDS, STOP_EMPHASES } from '../../v2/document.js';
import { FIELD_LIMITS_V3 as F, LIMITS_V3 as L } from '../../v3/limits.js';
import { CHART_FORMS, GRID_CELL_SIZES, PLAN_MARKS, TONES } from '../../v3/pictures.js';

/** Which reply the reference describes: the whole Scroll, the prose alone, or the staging of fixed prose. */
export type WrittenArm = 'one' | 'prose' | 'staging';

const TONE_WORDS = TONES.join('" | "');

/**
 * One example of every picture kind, over an invented subject (a pond), as the model writes it: no ids, references by
 * label, handles in "cites". Never evidence and never content to reuse.
 */
const PICTURE_REFERENCE = [
  `statement (one number, one quotation or a short list): {"kind":"statement","title":"What the picture is of","caption":"Optional line","cites":["e1"],"statement":{"form":"number","value":"23.4","label":"What the number is","tone":"warm"}}  |  "statement":{"form":"quote","text":"Words word for word from a cited passage","who":"Who said it","work":"Optional","year":"Optional"}  |  "statement":{"form":"list","items":[{"label":"First","note":"Optional"},{"label":"Second"}]}  (2 to 5 items; a statement always fits; "tone" is optional and one of "${TONE_WORDS}")`,
  `flow (steps in order, an arrow from each to the next): {"kind":"flow","title":"From spring to ice","cites":["e2"],"steps":[{"label":"Spring melt","note":"A sentence read when the step is reached.","tone":"cool"},{"label":"Summer warmth"},{"label":"Autumn chill"}]}  (2 to 6 steps)`,
  `cycle (items around a ring, the last leading back to the first): {"kind":"cycle","title":"The pond's year","cites":["e2"],"centre":{"label":"Pond"},"items":[{"label":"Thaw"},{"label":"Bloom"},{"label":"Fall"},{"label":"Freeze","note":"Optional"}]}  (3 to 8 items; "centre" is optional)`,
  `grid (a table, or a two by two of choices): {"kind":"grid","title":"Two ponds compared","cites":["e3"],"columns":[{"label":"Shallow"},{"label":"Deep"}],"rows":[{"label":"Summer"},{"label":"Winter"}],"cells":[{"row":"Summer","column":"Shallow","text":"Warm","tone":"warm"},{"row":"Summer","column":"Deep","text":"Cool"},{"row":"Winter","column":"Shallow","text":"Frozen solid","size":"large"},{"row":"Winter","column":"Deep","text":"Ice on top","note":"Optional"}]}  (1 to 3 columns, 1 to 4 rows, up to 12 cells; "row" and "column" are the exact labels of a row and a column; "size" is one of "${GRID_CELL_SIZES.join('" | "')}"; a cell is named by its "text")`,
  `chart (bars or a line of cited numbers): {"kind":"chart","title":"Ice cover","cites":["e4"],"form":"${CHART_FORMS.join('" | "')}","unit":"million people","values":"shown" | "hidden","points":[{"label":"1990","value":"8.3"},{"label":"2000","value":"12.5","note":"Optional"},{"label":"2010","value":"10"}],"marks":[{"point":"2000","label":"Peak year"}]}  (2 to 16 points. "marks" is ALWAYS written, even with nothing to mark: it labels up to 3 points on the drawing, a mark's "point" being the exact label of one of the points, and it is "marks":[] when no point needs a label; no other kind has "marks". EVERY "value" is digits only, a figure a cited passage states, written as that passage writes it: when it writes "8.3 million people" give "8.3" with the unit opening "million people", when it writes "8.3 people" give "8.3" with the unit "people"; the unit is words a cited passage uses; never convert, round or work out a value)`,
  `plan (a schematic plan on a grid of cells, never a map to scale): {"kind":"plan","title":"The pond and its paths","cites":["e5"],"size":{"columns":8,"rows":8},"ways":[{"label":"Main path","from":{"column":0,"row":3},"to":{"column":7,"row":3}}],"places":[{"label":"Dock","at":{"column":2,"row":3},"mark":"${PLAN_MARKS.join('" | "')}"},{"label":"Reeds","at":{"column":5,"row":5},"mark":"ring","note":"Optional"}],"tallies":[{"at":{"column":2,"row":3},"count":4,"step":0}],"steps":["Day 1","Day 2"],"regions":[{"label":"Dock side","nearest":"Dock","among":["Dock","Reeds"]}],"routes":[{"label":"Walk","from":"Dock","to":"Reeds"}]}  (columns and rows 6 to 12, a cell is {"column","row"} from 0; a way is a straight line along one row or column; at least 1 place and at most 12, each in its own cell; "steps" and a tally's "step" are optional, a step counts from 0; a region and a route name places by their exact labels, a region lists at least 2 places in "among" and "nearest" is one of them)`,
];

const PICTURE_RULES = [
  `Pictures are numbered 1, 2, 3 in the order of "pictures" (one to ${L.pictures.max}). Write no ids. Every picture field is a plain word or short phrase: never a colour, a coordinate in pixels, markup or a size.`,
  `A part of a picture is named by its exact label (a cell by its "text"). Labels are unique within one picture; only cells may repeat a text, and a repeated text cannot be linked or lit. A statement "number" has one part, "value"; a statement "quote" has one part, "quote".`,
  `A picture's "title" is at most ${F.pictureTitleChars} characters, a "caption" ${F.captionChars}, a label ${F.itemLabelChars}, a note ${F.itemNoteChars}, a cell's text ${F.cellTextChars}. A chart point's label is at most 24 characters. Every figure in a picture is one a cited passage states, written as it writes it.`,
];

const SHOW_REFERENCE = [
  `"show": {"picture":1,"upTo":3,"lit":["Spring melt"],"step":2,"region":"Dock side"}  (the picture this paragraph shows, from this paragraph on until another show. Keys by kind: flow, cycle, grid and chart take "upTo" (the first n items are drawn, a grid counts rows) and "lit" (up to 4 labels stand out); a statement takes "lit"; a plan takes "step", "lit" and "region". Give only what changes the view; {"picture":1} alone shows the whole picture. Every picture must be shown by some paragraph.)`,
  `"links": [{"phrase":"exact words of this paragraph","part":"Spring melt"}]  (up to ${L.linksPerBeat}; the phrase occurs once in the paragraph's text; the part is a label of the picture on screen, the one this paragraph shows or the last one an earlier paragraph of the same section showed; a new section starts with none)`,
  `"control": {"kind":"scrub","label":"Step through the year","along":"steps" | "items"}  |  {"kind":"switch","label":"Flip to winter","to":{"upTo":4}}  |  {"kind":"pick","label":"Pick a season"}  (at most ${L.controls} in the Scroll, on a paragraph that shows a picture, never on a quotation; a scrub needs two places to go, a switch a state that differs from the paragraph's, a pick at least two items with notes)`,
  `"emphasis": optional, one of "${STOP_EMPHASES.join('" | "')}".`,
];

const ESSAY_FIELDS = `"title":"…","dek":"…","takeaway":{"text":"One to three plain sentences.","cites":["e2"]},"askSuggestions":["…?","…?"]`;

const PROSE_ITEMS = [
  `items is one flat list in reading order. It starts with a "section" item. Two or three sections, ${L.beatsPerSection.min} to ${L.beatsPerSection.max} paragraphs each, ${L.beats.min} to ${L.beats.max} paragraphs and quotations in all, ${L.mainWords.min} to ${L.mainWords.max} words of paragraph text together.`,
  `section: {"type":"section","title":"At most ${F.sectionTitleChars} characters"}`,
  `para: {"type":"para","text":"One paragraph of at most ${L.beatWords} words (the first at most ${L.firstBeatWords}).","simple":"The same idea in plainer words.","cites":["e1","e3"]}`,
  `quote: {"type":"quote","text":"Word for word from a cited passage.","simple":"Plainer words for the reader who wants them.","who":"Who said it","work":"Optional","year":"Optional","cites":["e9"]}  (a quotation is a paragraph of its own and counts in the total)`,
  `aside: {"type":"aside","kind":"${ASIDE_KINDS.join('" | "')}","title":"Where this stops","text":"At most ${F.asideChars} characters.","cites":["e14"]}  (belongs to the paragraph or quotation just BEFORE it in the list; write it right after that item; at least one aside of kind "limits")`,
];

const TAIL = `takeaway: one to three plain sentences, at most ${F.takeawayChars.max} characters, that are not the dek again. askSuggestions: up to ${L.askSuggestions} full questions a curious reader would ask next. Every paragraph, quote, aside and picture, and the takeaway, cites one to eight offered passages by handle (e1, e2, …); a section carries no cites. A figure is stated only as a cited passage states it.`;

/**
 * The writer-facing shape of one reply of the document v3 writer, as compact annotated JSON. Limits come from the same
 * tables the schemas and the checks use, so the prompt cannot drift from what is enforced. Every example is invented
 * syntax guidance about an invented subject, never evidence and never content.
 *
 * - `one`: the whole Scroll in one reply (`WrittenScrollV3`).
 * - `prose`: the essay without pictures (`WrittenProseV3`).
 * - `staging`: the pictures and the stage over fixed prose (`WrittenStagingV3`).
 */
export function writtenReferenceV3(arm: WrittenArm): string {
  if (arm === 'prose') return [`Top level: {${ESSAY_FIELDS},"items":[item, …]}`, ...PROSE_ITEMS, TAIL].join('\n');
  if (arm === 'staging')
    return [
      `Top level: {"pictures":[picture, …],"stage":[{"para":3,"show":{…},"links":[…],"control":{…},"emphasis":"…"}, …]}`,
      `The paragraphs and quotations are numbered P1 to Pn in reading order. "stage" has at most one entry for each, listed by number in "para"; a paragraph not listed shows nothing new. You may not change a word of the prose.`,
      ...PICTURE_RULES,
      ...PICTURE_REFERENCE.map((line) => `picture, ${line}`),
      ...SHOW_REFERENCE,
    ].join('\n');
  return [
    `Top level: {${ESSAY_FIELDS},"pictures":[picture, …],"items":[item, …]}`,
    ...PICTURE_RULES,
    ...PICTURE_REFERENCE.map((line) => `picture, ${line}`),
    ...PROSE_ITEMS.map((line) =>
      line.startsWith('para:') || line.startsWith('quote:')
        ? `${line}  (may also carry "show", "links"${line.startsWith('para:') ? ', "control", "emphasis"' : ''}, below)`
        : line,
    ),
    ...SHOW_REFERENCE,
    TAIL,
  ].join('\n');
}
