import { CALLOUT_KINDS } from '../blocks/text.js';
import { FIELD_LIMITS as F, LIMITS as L } from '../limits.js';
import { AUTHORED_DIAGRAM_LAYOUTS, AUTHORED_NODE_KINDS, type AuthoredBlockType } from './authoring-schema.js';

/**
 * The writer-facing description of `scroll-authoring.v1`, one entry per block type. Limits come
 * from the same tables the schema and the canonical checks use, so the prompt cannot drift from
 * what is enforced. Every example is invented syntax guidance: a different subject from any
 * recipe, never evidence and never publishable content.
 */
const REFERENCE: Readonly<Record<AuthoredBlockType, string>> = {
  heading: `heading: {"type":"heading","text":"Starts a new section"} (a short title of a few words, up to ${F.headingChars} characters, never a sentence of prose; no cites; every heading is followed by at least one block of its own)`,

  paragraph: `paragraph: {"type":"paragraph","cites":["e2"],"text":"Your own prose, up to ${F.paragraphChars} characters."}`,

  list: `list: {"type":"list","cites":["e2"],"style":"bullet","items":["First point","Second point"]} (style bullet or number; 2 to ${F.listItems} items of up to ${F.listItemChars} characters)`,

  callout: `callout: {"type":"callout","cites":["e3"],"kind":"limit","title":"Where this picture stops","text":"Up to ${F.calloutChars} characters."} (kind: ${CALLOUT_KINDS.join(', ')}; "limit" says what the explanation cannot do; title is optional, up to ${F.calloutTitleChars} characters)`,

  comparison: `comparison: {"type":"comparison","cites":["e2","e4"],"title":"Two ways to move water","columns":["Pump","Gravity"],"rows":[["Needs power","Needs a slope"],["Lifts water uphill","Costs nothing to run"]]} (2 to ${F.comparisonColumns} columns; 1 to ${F.comparisonPoints} rows, one point of contrast each, with exactly one cell per column, up to ${F.comparisonPointChars} characters)`,

  timeline: `timeline: {"type":"timeline","cites":["e3"],"title":"How the canal grew","events":[{"when":"Early years","title":"A short ditch is dug","detail":"Optional sentence."},{"when":"Later","title":"Locks are added"}]} (2 to ${F.timelineEvents} events in time order; "when" up to 32 characters, title up to 80)`,

  sequence: `sequence: {"type":"sequence","cites":["e2","e3"],"title":"Passing through a lock","steps":[{"title":"Enter","text":"The boat drifts into the chamber."},{"title":"Rise","text":"Water fills the chamber and lifts the boat."}]} (2 to ${F.sequenceSteps} steps, the reader moves through them one at a time; step text up to ${F.stepChars} characters)`,

  diagram: `diagram: {"type":"diagram","cites":["e2"],"title":"A canal lock","instruction":"Pick a stage","layout":"flow-lr","interaction":"toggle","nodes":[{"id":"upper","label":"Upper pool"},{"id":"chamber","label":"Chamber","kind":"process"},{"id":"lower","label":"Lower pool"}],"edges":[{"id":"fill","from":"upper","to":"chamber","label":"Water in"},{"id":"drain","from":"chamber","to":"lower","label":"Water out","dashed":true}],"frames":[{"highlight":["fill","upper"],"label":"Filling","description":"Water flows in until the levels match."},{"highlight":["drain"],"hide":["fill"],"label":"Draining","description":"Water leaves toward the lower pool."}]}
  nodes: 2 to ${L.diagramNodes}, labels up to ${F.diagramLabelChars} characters, optional kind (${AUTHORED_NODE_KINDS.join(', ')}). edges: up to ${L.diagramEdges}, from and to name node ids. layout: ${AUTHORED_DIAGRAM_LAYOUTS.join(', ')} (code places the nodes; never give coordinates). interaction: toggle (one button per frame) or steps (Previous and Next).
  frames: 2 to ${L.diagramFrames} authored states, each a label (up to 40 characters) and a description of 10 to ${F.frameDescriptionChars} characters; highlight and hide list node or edge ids. The states must explain the mechanism, not just change decoration.`,

  'bar-chart': `bar-chart: {"type":"bar-chart","cites":["e2"],"title":"Boats per lock","categories":["North","South"],"series":[{"label":"Boats","values":[4,7]}],"axisLabel":"Boats","axisUnit":"boats","horizontal":false} (up to ${F.barCategories} categories; each series has one value per category; up to ${F.chartSeries} series; every number must come from a cited passage)`,

  'line-chart': `line-chart: {"type":"line-chart","cites":["e2"],"title":"Water level over a day","xLabel":"Hour","xUnit":"h","yLabel":"Level","yUnit":"m","series":[{"label":"Chamber","points":[[0,1],[2,3]]}]} (up to ${F.chartSeries} series of 2 to ${L.chartPoints} [x, y] points; every number must come from a cited passage)`,

  simulation: `simulation: {"type":"simulation","cites":["e4"],"title":"A stretched spring","prompt":"Drag the slider","params":[{"key":"stretch","label":"Stretch","unit":"cm","min":0,"max":10,"step":1,"default":4}],"constants":[{"key":"stiffness","label":"Stiffness","value":3,"unit":"N/cm"}],"outputs":[{"key":"force","label":"Pulling force","unit":"N","decimals":1,"formula":{"kind":"product","factors":["stretch","stiffness"]}}],"view":"plot","readout":"A stretch of {stretch} cm pulls with {force} N.","note":"An invented spring: real springs stop following this rule when overstretched."}
  The reader moves the parameters (up to ${L.paramsPerBlock}); outputs (up to ${F.outputs}) are computed from them. Keys: camelCase letters and digits, starting lowercase, up to 24 characters. For each parameter (max − min) / step must be a whole number of at most ${F.sliderPositions} and default must be one of its values. Operands are numbers or keys of parameters, constants and earlier outputs. Formulas (no other kinds, no expressions):
  {"kind":"linear","x":O,"a":O,"b":O} = a·x + b | {"kind":"product","factors":[O,O]} (2 to 4) | {"kind":"ratio","numerator":O,"denominator":O} | {"kind":"power","x":O,"base":O,"exponent":2,"scale":O} = scale·(x/base)^exponent, exponent −4 to 4 | {"kind":"exponential","x":O,"rate":O,"initial":O} = initial·e^(rate·x) | {"kind":"inverse-square","r":O,"k":O} = k/r² | {"kind":"lookup","input":"paramKey","mode":"interpolate","table":[{"at":0,"value":1},{"at":5,"value":3}]} (2 to ${F.lookupEntries} entries, "at" increasing)
  view: readout (one large number, default), plot (the first output as a curve over the first parameter) or cards (all outputs side by side, needs 2 or more outputs and no negative value). readout: a sentence using {key} placeholders. Every output must stay finite. The reader is always shown that the numbers are illustrative, so use simple teaching values and keep digits out of labels and notes.`,
};

/** The reference lines for the block types a recipe may use, in the given order. */
export function authoringReference(types: readonly AuthoredBlockType[]): string {
  return types.map((type) => REFERENCE[type]).join('\n');
}
