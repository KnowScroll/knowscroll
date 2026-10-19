import { DIAGRAM_LAYOUTS } from '../blocks/diagram.js';
import { CODE_LANGUAGES } from '../blocks/reference.js';
import { CALLOUT_KINDS } from '../blocks/text.js';
import { FIELD_LIMITS as F, LIMITS as L } from '../limits.js';
import { STRUCTURAL_LITERALS } from '../internal/honesty.js';
import { formatNumber } from '../simulation/evaluate.js';
import { SCROLL_DRAFT_VERSION } from './draft.js';

/** Largest catalogue the writer prompt may carry (UTF-8 bytes). */
export const CATALOGUE_MAX_BYTES = 8_192;

const join = (values: readonly string[]) => values.join('|');

/**
 * The compact, hand-written description of `scroll-draft.v1` for the writer prompt: every authored
 * block type, its data and limits, the formula kinds and views, bindings and the rules the checks
 * enforce. Numbers come from the limits tables, so the prompt and the validator cannot drift.
 * The full JSON Schema (`scrollDraftJsonSchema`) is far larger and is meant for constrained
 * decoding only.
 */
export function blockCatalogueText(): string {
  const literals = [...STRUCTURAL_LITERALS].join(', ');
  const visible = formatNumber(L.visibleChars, { decimals: 0, grouping: true, approximate: false });
  const lines = [
    `Return exactly one JSON object, ${SCROLL_DRAFT_VERSION}:`,
    `{"draftVersion":"${SCROLL_DRAFT_VERSION}","title":4–${F.titleChars} chars,"dek":10–${F.dekChars},"sections":[1–${L.sections} {"id"?,"heading":≤${F.headingChars} or null (first section only),"blocks":[Block…]}],"bindings":[Binding…]}`,
    `Block = {"id"?,"type","a11y"?:{"label"≤${F.a11yLabelChars},"description"?≤${F.a11yDescriptionChars}},"fallbackText"?:${F.fallbackTextMinChars}–${F.fallbackTextChars} chars,"essential"?:bool,"data"}`,
    'id: lowercase letters, digits, hyphens (e.g. "why-squared"); unique across sections and blocks; give one to every block you bind; when revising, keep the ids of unchanged blocks.',
    'Text = a string, or spans [{"text","marks"?:["em"|"strong"|"code"]}]. Every string is one line: no line breaks, no web addresses, no source or publisher names.',
    'essential = the argument depends on this block.',
    '',
    'TEXT BLOCKS (code writes their a11y and fallbackText):',
    `paragraph {spans:Text≤${F.paragraphChars}}`,
    `subheading {text≤${F.headingChars}}`,
    `list {style:bullet|number,items:[2–${F.listItems} Text≤${F.listItemChars}]}`,
    `quote {kind:pull|quotation,spans:Text≤${F.quoteChars},attribution? (quotation only)}`,
    `callout {kind:${join(CALLOUT_KINDS)},title?≤${F.calloutTitleChars},spans:Text≤${F.calloutChars}} — "limit" says what the explanation cannot do; "try-it" invites using the block above.`,
    '',
    `OTHER BLOCKS (each needs a11y.label and a standalone fallbackText ≥${F.fallbackTextMinChars} chars that makes sense without the block):`,
    `disclosure {summary≤${F.disclosureSummaryChars},blocks:[1–${F.disclosureBlocks} of paragraph|list|quote|callout|code|table|figure]}`,
    `code {language:${join(CODE_LANGUAGES)},title?,code (≤${L.codeChars} chars, ≤${F.codeLines} lines, ≤${F.codeLineChars} per line; newlines allowed),caption?,highlightLines?:[line numbers]} — shown, never run.`,
    `table {caption,columns:[1–${L.tableColumns} {label,align:start|end,unit?}],rows:[1–${L.tableRows} rows, one cell per column: ""|text≤${F.tableCellChars}|number],rowHeader:bool}`,
    `figure {media:{mediaId,revision} (offered media only),motion:still|loop,alt:10–${F.altChars},caption?}`,
    `media {kind:video|audio,media,poster (video only, required),captions (video, required),alt,transcript≤${F.transcriptChars},durationMs≤${F.mediaDurationMs}}`,
    `comparison {title,columns:[2–${F.comparisonColumns} {label,points:[1–${F.comparisonPoints} Text≤${F.comparisonPointChars}]}],caption?}`,
    `timeline {title,events:[2–${F.timelineEvents} {id,when≤32,title≤80,detail?:Text≤400}] in time order}`,
    `sequence {title,steps:[2–${F.sequenceSteps} {id,title≤80,spans:Text≤${F.stepChars},figure?:{media,alt}}]} — one step at a time.`,
    `diagram {title,instruction?,layout:${join(DIAGRAM_LAYOUTS)},nodes:[2–${L.diagramNodes} {id,label≤${F.diagramLabelChars},kind:entity|process|store|actor|note|token,group?,cell?:{column,row 0–5} (grid layout: required on every node; other layouts: none)}],edges:[≤${L.diagramEdges} {id,from,to,label?,directed:bool,style:solid|dashed,weight?:0–1}],groups:[≤${F.diagramGroups} {id,label}],frames:[≤${L.diagramFrames} {id,label≤40,description:10–${F.frameDescriptionChars},emphasis:[node/edge ids],hidden:[node/edge ids],weights:[{edge,weight}]}],interaction}`,
    '  interaction: {kind:static} (no frames) | {kind:steps} (Previous/Next) | {kind:toggle} (one button per frame) | {kind:drag-to-target,token:<node of kind token>,targets:[2–6 {node,frame}],initialFrame}. Frames are authored states; there is no physics.',
    `chart {title,caption?,spec} — static, ≤${L.chartPoints} data points; axis {label,unit?,scale:linear|log,domain?:[low,high]}`,
    `  spec: {kind:bar,orientation:vertical|horizontal,categories:[≤${F.barCategories}],series:[≤${F.chartSeries} {id,label,values (one per category)}],valueAxis} | {kind:line|scatter,x,y,series:[≤${F.chartSeries} {id,label,points:[[x,y]…]}]} | {kind:heatmap,rows,columns (≤${F.heatmapSide} each),values:[[row values]],scale:{label,min,max},highlightRow?}`,
    `simulation {title,prompt?,params:[1–${L.paramsPerBlock}],constants:[≤${F.constants} {key,label,value,unit?}],outputs:[1–${F.outputs} {key,label,unit?,formula,format}],view,readout?,modelNote:10–240 (units, assumptions, limits),illustrative:bool}`,
    `  param {key (camelCase),label,unit?,min,max,step,default,control:slider|stepper|input,format,personal?:true}: (max−min)/step a whole number ≤${F.sliderPositions}; default on the grid; personal = the reader's own data (weight, age).`,
    '  format {decimals:0–4,grouping:bool,approximate:bool ("~"),suffix?} · operand = a number or a key (parameter, constant or earlier output).',
    '  formula (closed kinds, no expressions): linear{x,a,b}=a·x+b · product{factors:[2–4]} · ratio{numerator,denominator} · power{x,base,exponent:−4…4,scale}=scale·(x/base)^exponent · exponential{x,rate,initial}=initial·e^(rate·x) · inverse-square{r,k}=k/r² · lookup{input,mode:step|interpolate,table:[2–12 {at (increasing),value}]}',
    '  view: readout{primary,secondary?} | cards{items:[2–8 {id,label,output,note?}],barMax} | plot{x:<param>,y:<output>,yLabel,yDomain:[low,high]} | area{length:<param>,area:<output>,lengthLabel,areaLabel}',
    `  readout {template ("{key} the work of …"),bands:[≤${F.readoutBands} {output,min?,max?,text}]}; outputs must stay finite over the parameter ranges.`,
    '',
    'Binding = {kind:passage,claimId,blockId,anchorText (copied exactly from that text block; occurs once)} | {kind:constant,claimId,blockId,constantKey} | {kind:block,claimId,blockId}. Use only offered claim ids.',
    '',
    'RULES (each is checked):',
    '1. Explain, do not summarise: an opening, a mechanism, an example and its limits (a closing limit callout is recommended).',
    '2. Use your own words: never 9 or more consecutive words from a claim quote or excerpt.',
    '3. Every sentence with a digit is covered by a passage binding. Any other block showing a digit, and every chart, needs a binding.',
    `4. A simulation with illustrative:false binds every constant. In any simulation, numbers other than ${literals} are named constants, never bare literals.`,
    `5. At most ${L.blocks} blocks (nested included), ${L.interactiveBlocks} interactive (simulation, sequence, media, non-static diagram), ${L.paramsTotal} parameters, ${visible} visible characters.`,
    '6. Use an interactive block only where doing something explains better than reading.',
    '7. Never write "fallback" blocks, "version" or "gesture": code sets them, and the reading time.',
    '8. In a hypothetical, write conditionally ("if…, then in this model…"); never state a consequence as established fact.',
  ];
  return lines.join('\n');
}
