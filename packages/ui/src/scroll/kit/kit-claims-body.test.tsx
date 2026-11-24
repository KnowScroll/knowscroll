import { render } from '@testing-library/react-native';
import Svg, { Line } from 'react-native-svg';
import { kitDefinition, kitKeys, type StageKitId, type WordState } from '@knowscroll/scroll-model';
import { BLUE, SUN, WARM } from './parts';
import { KIT_PICTURES } from './registry';

/**
 * The claims of the nerve kit against their pictures. A text version says things about a picture, and
 * the picture must carry a mark for each: a claim with no mark is a picture that does not show what it says, and
 * a mark with no claim is a picture that shows what the text leaves out. Every row pairs a sentence of the text
 * version with a mark found in the rendered picture, and the two must be present together in every settled state
 * (with no focus: the ring for a focus is `kit-focus.test.tsx`'s). Every label the picture draws is either a
 * claim of a row or a plain name. Negations ("left out") make no claim of the picture and have no row.
 */

type Node = {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[] | null;
};

function nodesOf(tree: unknown): Node[] {
  if (typeof tree !== 'object' || tree === null) return [];
  const node = tree as Node;
  return [node, ...(node.children ?? []).flatMap(nodesOf)];
}

const num = (node: Node, key: string): number => Number(node.props?.[key]);
const ofType = (nodes: readonly Node[], type: string): Node[] => nodes.filter((node) => node.type === type);

/** How a colour looks once rendered, learned from the shared part itself. */
async function colourLooks(): Promise<Record<'sun' | 'blue' | 'warm', string>> {
  const view = await render(
    <Svg>
      <Line x1={0} y1={0} x2={1} y2={1} stroke={SUN} />
      <Line x1={0} y1={0} x2={1} y2={1} stroke={BLUE} />
      <Line x1={0} y1={0} x2={1} y2={1} stroke={WARM} />
    </Svg>,
  );
  const [sun, blue, warm] = ofType(nodesOf(view.toJSON()), 'RNSVGLine').map((line) =>
    JSON.stringify(line.props?.['stroke']),
  );
  await view.unmount();
  return { sun: sun ?? '', blue: blue ?? '', warm: warm ?? '' };
}

interface Marks {
  readonly nodes: readonly Node[];
  readonly labels: readonly string[];
  readonly colours: Record<'sun' | 'blue' | 'warm', string>;
  readonly lines: readonly Node[];
  readonly circles: readonly Node[];
  readonly ellipses: readonly Node[];
  readonly rects: readonly Node[];
}

const hasLabel = (marks: Marks, pattern: RegExp): boolean => marks.labels.some((label) => pattern.test(label));

interface Row {
  readonly name: string;
  readonly claim: RegExp;
  readonly mark: (marks: Marks) => boolean;
}

const sunLine = (marks: Marks, x: number): boolean =>
  marks.lines.some((line) => JSON.stringify(line.props?.['stroke']) === marks.colours.sun && num(line, 'x1') === x);
const blueLine = (marks: Marks, x: number): boolean =>
  marks.lines.some((line) => JSON.stringify(line.props?.['stroke']) === marks.colours.blue && num(line, 'x1') === x);
const circleWith = (marks: Marks, radius: number, colour: string): Node[] =>
  marks.circles.filter((circle) => num(circle, 'r') === radius && JSON.stringify(circle.props?.['fill']) === colour);

/** Where the next cell's voltage marker sits against its rest line, in the synapse view (negative: above). */
function markerAgainstRest(marks: Marks): number | undefined {
  const marker = marks.circles.find((circle) => num(circle, 'r') === 5 && num(circle, 'strokeWidth') === 1.8);
  const rest = marks.lines.find(
    (line) => num(line, 'x1') === 176 && JSON.stringify(line.props?.['strokeDasharray']) === '["4","4"]',
  );
  return marker === undefined || rest === undefined ? undefined : num(marker, 'cy') - num(rest, 'y1');
}

const ionsDrawn = (marks: Marks): boolean => circleWith(marks, 2.8, marks.colours.sun).length > 0;

const NERVE_ROWS: readonly Row[] = [
  {
    name: 'the sodium channels begin to open',
    claim: /sodium channels begin to open/u,
    mark: (m) =>
      m.lines.some(
        (line) =>
          num(line, 'x1') === 100 && num(line, 'strokeWidth') === 2.4 && line.props?.['strokeDasharray'] !== undefined,
      ),
  },
  { name: 'sodium ions rush in', claim: /sodium ions rush in|less sodium flows in/u, mark: (m) => sunLine(m, 100) },
  {
    name: 'potassium ions flow out',
    claim: /potassium ions flow out|potassium still flows out/u,
    mark: (m) => blueLine(m, 220),
  },
  {
    name: 'the sodium channels are shutting or recovering',
    claim: /sodium channels are (?:shutting themselves|still recovering)/u,
    mark: (m) => circleWith(m, 7, m.colours.warm).some((circle) => num(circle, 'cx') === 100),
  },
  {
    name: 'a fresh push would not fire the cell',
    claim: /A fresh push that would normally make the cell fire does not/u,
    mark: (m) => hasLabel(m, /A FRESH PUSH WOULD NOT FIRE IT NOW/u),
  },
  {
    name: 'the membrane behind the spike is recovering',
    claim: /Behind it the membrane is recovering/u,
    mark: (m) => hasLabel(m, /^RECOVERING$/u),
  },
  {
    name: 'the membrane ahead is at rest and ready',
    claim: /Ahead of the spike the membrane is at rest and ready/u,
    mark: (m) => hasLabel(m, /^READY$/u),
  },
  {
    name: 'the signal runs one way',
    claim: /the signal runs on in one direction/u,
    mark: (m) => hasLabel(m, /THE SIGNAL RUNS THIS WAY/u),
  },
  {
    name: 'a spike arrives at the end of the sending cell',
    claim: /A spike reaches the end of the sending cell/u,
    mark: (m) => hasLabel(m, /^SPIKE$/u),
  },
  {
    name: 'the packets have released',
    claim: /join the membrane|spreads across the gap|binds receptors|cleared away/u,
    mark: (m) => m.circles.some((circle) => num(circle, 'r') === 6 && circle.props?.['strokeDasharray'] !== undefined),
  },
  {
    name: 'neurotransmitter is in the gap',
    claim: /release their neurotransmitter into the gap|spreads across the gap|binds receptors/u,
    mark: (m) => circleWith(m, 3.2, m.colours.warm).length > 0,
  },
  { name: 'the receptors’ channels are open with ions in them', claim: /opens their channels/u, mark: ionsDrawn },
  {
    name: 'the next cell moves toward the threshold',
    claim: /voltage moves toward the threshold/u,
    mark: (m) => ionsDrawn(m) && (markerAgainstRest(m) ?? 0) < 0,
  },
  {
    name: 'the next cell moves away from the threshold',
    claim: /voltage moves away from the threshold/u,
    mark: (m) => ionsDrawn(m) && (markerAgainstRest(m) ?? 0) > 0,
  },
  {
    name: 'the news is on its way to the brain',
    claim: /still on its way up to the brain|also starts up toward the brain/u,
    mark: (m) => hasLabel(m, /NEWS ON ITS WAY/u),
  },
  {
    name: 'the muscle has responded',
    claim: /The muscle responds|after the muscle has already responded/u,
    mark: (m) => m.ellipses.some((ellipse) => num(ellipse, 'cx') === 250 && num(ellipse, 'rx') === 20),
  },
  {
    name: 'the news has reached the brain',
    claim: /The news reaches the brain/u,
    mark: (m) =>
      m.ellipses.some(
        (ellipse) => num(ellipse, 'rx') === 32 && JSON.stringify(ellipse.props?.['fill']) === m.colours.sun,
      ),
  },
];

const NERVE_NAMES: readonly RegExp[] = [
  /^VOLTAGE: INSIDE AGAINST OUTSIDE$/u,
  /^(TIME|ALONG THE AXON|0|REST|THRESHOLD|OUTSIDE|INSIDE)$/u,
  /^(SODIUM|POTASSIUM) CHANNEL$/u,
  /^(WEAK PUSH|STRONGER|STRONGEST)$/u,
  /^WEAK: NOTHING\. ENOUGH OR MORE: THE SAME SPIKE$/u,
  /^CELL BODY$/u,
  /^(SENDING|NEXT) CELL$/u,
  /^GAP$/u,
  /^NEXT CELL’S VOLTAGE$/u,
  /^(BRAIN|SENSOR|SENSORY NEURON|SPINAL CORD|MOTOR NEURON|MUSCLE)$/u,
  /A FRESH PUSH WOULD NOT FIRE IT NOW/u,
  /^RECOVERING$/u,
  /^READY$/u,
  /THE SIGNAL RUNS THIS WAY/u,
  /^SPIKE$/u,
  /NEWS ON ITS WAY/u,
];

/** Every settled state of a kit with no focus, once each. */
function settledStates(kit: StageKitId): WordState[] {
  const definition = kitDefinition(kit);
  const all = kitKeys(definition).reduce<WordState[]>(
    (states, key) =>
      states.flatMap((state) => (definition.enums[key] ?? []).map((word) => ({ ...state, [key]: word }))),
    [{}],
  );
  const seen = new Map<string, WordState>();
  for (const state of all.map(definition.settle)) if (state['focus'] === 'none') seen.set(JSON.stringify(state), state);
  return [...seen.values()];
}

async function marksOf(kit: StageKitId, state: WordState): Promise<Marks> {
  const picture = KIT_PICTURES[kit];
  const colours = await colourLooks();
  const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
  const nodes = nodesOf(view.toJSON());
  await view.unmount();
  const labels = ofType(nodes, 'RNSVGTSpan').map((span) => String(span.props?.['content']));
  return {
    nodes,
    labels,
    colours,
    lines: ofType(nodes, 'RNSVGLine'),
    circles: ofType(nodes, 'RNSVGCircle'),
    ellipses: ofType(nodes, 'RNSVGEllipse'),
    rects: ofType(nodes, 'RNSVGRect'),
  };
}

describe.each([['nerve.v1', NERVE_ROWS, NERVE_NAMES]] as const)(
  'the claims of the kit %s against its picture',
  (kit, rows, names) => {
    it('has each sentence of the text version beside its mark in the picture, and each mark beside its sentence, in every state', async () => {
      const mismatches: string[] = [];
      const unknownLabels = new Set<string>();
      const said = new Set<string>();
      for (const state of settledStates(kit)) {
        const alt = kitDefinition(kit).describe(state);
        const marks = await marksOf(kit, state);
        for (const row of rows) {
          const claimed = row.claim.test(alt);
          const drawn = row.mark(marks);
          if (claimed) said.add(row.name);
          if (claimed !== drawn)
            mismatches.push(
              `${row.name}: text ${claimed ? 'says it' : 'is silent'}, picture ${drawn ? 'draws it' : 'does not'} in ${JSON.stringify(state)}`,
            );
        }
        for (const label of marks.labels) if (!names.some((name) => name.test(label))) unknownLabels.add(label);
      }
      expect(mismatches).toEqual([]);
      expect([...unknownLabels]).toEqual([]);
      // Every row was said in some state, so no row is checking nothing.
      expect(rows.map((row) => row.name).filter((name) => !said.has(name))).toEqual([]);
    });
  },
);
