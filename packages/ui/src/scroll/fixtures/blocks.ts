import {
  deriveGesture,
  evaluateSimulation,
  gridValues,
  type AnyBlock,
  type BlockOfType,
  type SimulationData,
  type SimulationDisplay,
} from '../model';
import { em, spans } from './build';

/**
 * Fixture blocks for every non-text block type: original, labelled, never product content. Each
 * is finished with the gesture the package derives from its data (`deriveGesture`), as code does
 * when it builds a stored revision.
 */

function finish<T extends AnyBlock>(block: T): T {
  return { ...block, gesture: deriveGesture(block) };
}

type SimulationBody = Omit<SimulationData, 'display'>;

/**
 * The display scale of a simulation, as admission computes it from the whole grid and stores it
 * (`SimulationData.display`): the largest card or area value, or the range of the plotted output.
 * Fixtures compute it here by sweeping the grid (they are test and gallery data; a client never does
 * this, it reads the stored value). The simulation tests check it against admission itself.
 */
function displayOf(data: SimulationBody): SimulationDisplay {
  const points: Record<string, number>[] = [{}];
  for (const param of data.params) {
    const values = gridValues(param);
    const next: Record<string, number>[] = [];
    for (const point of points) for (const value of values) next.push({ ...point, [param.key]: value });
    points.splice(0, points.length, ...next);
  }
  const outputs = points.map((point) => evaluateSimulation(data, point).outputs);
  const peak = (keys: readonly string[]) =>
    Math.max(...outputs.flatMap((values) => keys.map((key) => values[key] ?? 0)));
  switch (data.view.kind) {
    case 'readout':
      return { kind: 'none' };
    case 'cards': {
      const largest = peak(data.view.items.map((item) => item.output));
      return { kind: 'cards', scale: largest > 0 ? largest : 1 };
    }
    case 'area': {
      const largest = peak([data.view.area]);
      return { kind: 'area', scale: largest > 0 ? largest : 1 };
    }
    case 'plot': {
      const key = data.view.y;
      const ys = outputs.map((values) => values[key] ?? 0);
      const high = Math.max(...ys);
      const low = Math.min(0, ...ys);
      return { kind: 'plot', range: high > low ? [low, high] : [low, low + 1] };
    }
  }
}

/** A simulation block: its data plus the display the grid gives it. */
function simulation(
  block: Omit<BlockOfType<'simulation'>, 'data'> & { data: SimulationBody },
): BlockOfType<'simulation'> {
  const complete: BlockOfType<'simulation'> = { ...block, data: { ...block.data, display: displayOf(block.data) } };
  return finish(complete);
}

const plain = { decimals: 0, grouping: false, approximate: false } as const;
const grouped = { decimals: 0, grouping: true, approximate: false } as const;
const one = { decimals: 1, grouping: false, approximate: false } as const;

export function tableBlock(id: string): BlockOfType<'table'> {
  return finish<BlockOfType<'table'>>({
    id,
    type: 'table',
    version: 1,
    a11y: { label: 'Table: deck weight by span' },
    fallbackText: 'A table of deck weight for four spans: 40 m, 80 m, 120 m and 160 m, in steel or concrete.',
    essential: false,
    gesture: 'none',
    data: {
      caption: 'Deck weight by span, as an illustration',
      columns: [
        { label: 'Span', unit: 'm', align: 'end' },
        { label: 'Deck weight', unit: 'kN', align: 'end' },
        { label: 'Material', align: 'start' },
      ],
      rows: [
        [40, 740, 'Steel'],
        [80, 1480, 'Steel'],
        [120, 2220, 'Concrete'],
        [160, 2960, 'Steel'],
      ],
      rowHeader: false,
    },
  });
}

export function figureBlock(id: string, media = 'fixture-arch'): BlockOfType<'figure'> {
  return finish<BlockOfType<'figure'>>({
    id,
    type: 'figure',
    version: 1,
    a11y: { label: 'Figure: a stone arch' },
    fallbackText: 'A drawing of a stone arch bridge, with every stone leaning on its neighbours.',
    essential: false,
    gesture: 'none',
    data: {
      media: { mediaId: media, revision: 1 },
      motion: 'still',
      alt: 'A side view of a stone arch bridge, its stones leaning together under the road.',
      caption: 'In an arch every stone is pressed by its neighbours.',
    },
  });
}

export function audioBlock(id: string): BlockOfType<'media'> {
  return finish<BlockOfType<'media'>>({
    id,
    type: 'media',
    version: 1,
    a11y: { label: 'Audio: a note about bearings' },
    fallbackText: 'A short spoken note says that a bridge deck needs room to expand, so one end rests on a bearing.',
    essential: false,
    gesture: 'none',
    data: {
      kind: 'audio',
      media: { mediaId: 'fixture-bearings', revision: 1 },
      alt: 'A short spoken note about how bridge bearings let a deck breathe.',
      transcript:
        'A deck grows a little in the heat and shrinks in the cold. One end is fixed and the other rests on a bearing, so it can slide and the bridge does not push itself apart.',
      durationMs: 42_000,
    },
  });
}

export function comparisonBlock(id: string, columnCount: 2 | 3 = 2): BlockOfType<'comparison'> {
  const columns = [
    { label: 'Arch', points: [spans('Pushes inward on its ends.'), spans('Wants stone and a firm bank.')] },
    { label: 'Suspension', points: [spans('Hangs from cables in ', em('tension'), '.'), spans('Needs tall towers.')] },
    {
      label: 'Beam',
      points: [spans('Rests on piers and bends a little.'), spans('Simple, and best for short spans.')],
    },
  ];
  return finish<BlockOfType<'comparison'>>({
    id,
    type: 'comparison',
    version: 1,
    a11y: { label: 'Comparison: ways to hold a span' },
    fallbackText:
      'Compares an arch, which pushes inward, with a suspension bridge, which hangs from cables in tension.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Ways to hold a span',
      columns: columns.slice(0, columnCount),
      caption: 'Each design puts the same load somewhere different.',
    },
  });
}

export function timelineBlock(id: string): BlockOfType<'timeline'> {
  return finish<BlockOfType<'timeline'>>({
    id,
    type: 'timeline',
    version: 1,
    a11y: { label: 'Timeline: a bridge’s first century' },
    fallbackText: 'A bridge is planned, built, opened, repaired for the first time and then inspected for a century.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'A bridge’s first century',
      events: [
        {
          id: 'tl-plan',
          when: 'Year 0',
          title: 'Planned',
          detail: spans('The loads are added up and the shape is chosen.'),
        },
        { id: 'tl-open', when: 'Year 3', title: 'Opened' },
        {
          id: 'tl-fix',
          when: 'Year 40',
          title: 'First big repair',
          detail: spans('Joints and bearings are replaced; the structure stays.'),
        },
        { id: 'tl-old', when: 'Year 100', title: 'Still inspected' },
      ],
    },
  });
}

export function sequenceBlock(id: string): BlockOfType<'sequence'> {
  return finish<BlockOfType<'sequence'>>({
    id,
    type: 'sequence',
    version: 1,
    a11y: { label: 'Steps: sizing a bridge' },
    fallbackText: 'Four steps: measure the gap, choose the shape, add the loads, and check the margin.',
    essential: true,
    gesture: 'none',
    data: {
      title: 'Sizing a bridge',
      steps: [
        {
          id: 'st-gap',
          title: 'Measure the gap',
          spans: spans('Everything starts with how far the bridge has to reach, and what is at each end.'),
        },
        {
          id: 'st-shape',
          title: 'Choose the shape',
          spans: spans(
            'A short gap wants a beam. A long one wants an arch or cables. The shape decides which parts push and which pull.',
          ),
        },
        {
          id: 'st-loads',
          title: 'Add the loads',
          spans: spans('Add the bridge’s own weight, the traffic, and the weather it will meet.'),
          figure: {
            media: { mediaId: 'fixture-loads', revision: 1 },
            alt: 'Arrows pressing down on a deck from above and a smaller arrow pushing sideways.',
          },
        },
        {
          id: 'st-margin',
          title: 'Check the margin',
          spans: spans('The result must come out well under what the parts can take.'),
        },
      ],
    },
  });
}

/** The step-through diagram of PR A: the load path from the deck to the ground. */
export function loadPathDiagram(id: string): BlockOfType<'diagram'> {
  return finish<BlockOfType<'diagram'>>({
    id,
    type: 'diagram',
    version: 1,
    a11y: { label: 'Diagram: where the load goes' },
    fallbackText:
      'The deck passes its load to the cables, the cables pass it to the towers, and the towers pass it down to the ground.',
    essential: true,
    gesture: 'none',
    data: {
      title: 'Where the load goes',
      layout: 'flow-lr',
      nodes: [
        { id: 'deck', label: 'Deck', kind: 'entity' },
        { id: 'cables', label: 'Cables', kind: 'process' },
        { id: 'towers', label: 'Towers', kind: 'entity' },
        { id: 'ground', label: 'Ground', kind: 'store' },
      ],
      edges: [
        { id: 'e-deck-cables', from: 'deck', to: 'cables', directed: true, style: 'solid', weight: 0.6 },
        { id: 'e-cables-towers', from: 'cables', to: 'towers', directed: true, style: 'solid', weight: 0.6 },
        { id: 'e-towers-ground', from: 'towers', to: 'ground', directed: true, style: 'solid', weight: 0.6 },
      ],
      groups: [],
      frames: [
        {
          id: 'f-deck',
          label: 'The deck',
          description: 'Traffic and the deck itself press down, and the deck hands that weight to the cables.',
          emphasis: ['deck', 'e-deck-cables'],
          hidden: [],
          weights: [],
        },
        {
          id: 'f-towers',
          label: 'The towers',
          description: 'The cables pull on the towers, and the towers carry that pull as a push.',
          emphasis: ['cables', 'towers', 'e-cables-towers'],
          hidden: [],
          weights: [],
        },
        {
          id: 'f-ground',
          label: 'The ground',
          description: 'The towers pass the load into the ground, which is where it ends.',
          emphasis: ['towers', 'ground', 'e-towers-ground'],
          hidden: [],
          weights: [],
        },
      ],
      interaction: { kind: 'steps' },
    },
  });
}

/** A token the reader drags onto one of three supports; each support is a frame that re-weights the lines. */
export function weightDiagram(id: string): BlockOfType<'diagram'> {
  const frame = (key: 'left' | 'mid' | 'right', label: string, weights: [number, number, number]) => ({
    id: `f-${key}`,
    label,
    description: `With the weight over the ${label.toLowerCase()}, the thickest line shows which support carries most of it.`,
    emphasis: [`e-${key}`, key],
    hidden: [],
    weights: [
      { edge: 'e-left', weight: weights[0] },
      { edge: 'e-mid', weight: weights[1] },
      { edge: 'e-right', weight: weights[2] },
    ],
  });
  return finish<BlockOfType<'diagram'>>({
    id,
    type: 'diagram',
    version: 1,
    a11y: {
      label: 'Diagram: where the weight sits',
      description: 'A weight joined to three supports; the thicker the line, the more that support carries.',
    },
    fallbackText:
      'A weight sits on a deck held by a left support, a middle support and a right support. The closer it is to one, the more that support carries.',
    essential: true,
    gesture: 'none',
    data: {
      title: 'Where does the weight go?',
      instruction: 'Drag the weight toward a support',
      layout: 'radial',
      nodes: [
        { id: 'load', label: 'weight', kind: 'token' },
        { id: 'left', label: 'Left pier', kind: 'entity' },
        { id: 'mid', label: 'Middle', kind: 'entity' },
        { id: 'right', label: 'Right pier', kind: 'entity' },
      ],
      edges: [
        { id: 'e-left', from: 'load', to: 'left', directed: false, style: 'solid' },
        { id: 'e-mid', from: 'load', to: 'mid', directed: false, style: 'solid' },
        { id: 'e-right', from: 'load', to: 'right', directed: false, style: 'solid' },
      ],
      groups: [],
      frames: [
        frame('left', 'Left pier', [0.9, 0.3, 0.1]),
        frame('mid', 'Middle', [0.4, 0.9, 0.4]),
        frame('right', 'Right pier', [0.1, 0.3, 0.9]),
      ],
      interaction: {
        kind: 'drag-to-target',
        token: 'load',
        targets: [
          { node: 'left', frame: 'f-left' },
          { node: 'mid', frame: 'f-mid' },
          { node: 'right', frame: 'f-right' },
        ],
        initialFrame: 'f-mid',
      },
    },
  });
}

/** One button per frame, on a ring: plan, build, inspect. */
export function cycleDiagram(id: string): BlockOfType<'diagram'> {
  return finish<BlockOfType<'diagram'>>({
    id,
    type: 'diagram',
    version: 1,
    a11y: { label: 'Diagram: the life of a bridge' },
    fallbackText:
      'A cycle of three stages: plan, build and inspect, and then the plan is revised from what the inspection found.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'The life of a bridge',
      layout: 'cycle',
      nodes: [
        { id: 'plan', label: 'Plan', kind: 'process' },
        { id: 'build', label: 'Build', kind: 'process' },
        { id: 'inspect', label: 'Inspect', kind: 'process' },
      ],
      edges: [
        { id: 'c-plan-build', from: 'plan', to: 'build', directed: true, style: 'solid' },
        { id: 'c-build-inspect', from: 'build', to: 'inspect', directed: true, style: 'solid' },
        { id: 'c-inspect-plan', from: 'inspect', to: 'plan', directed: true, style: 'dashed', label: 'revise' },
      ],
      groups: [],
      frames: [
        {
          id: 'c-1',
          label: 'Plan',
          description: 'Loads are added up and a shape is chosen.',
          emphasis: ['plan', 'c-plan-build'],
          hidden: [],
          weights: [],
        },
        {
          id: 'c-2',
          label: 'Build',
          description: 'Parts are made and put in place, one after another.',
          emphasis: ['build', 'c-build-inspect'],
          hidden: [],
          weights: [],
        },
        {
          id: 'c-3',
          label: 'Inspect',
          description: 'The bridge is checked for wear, and what is found revises the plan.',
          emphasis: ['inspect', 'c-inspect-plan'],
          hidden: [],
          weights: [],
        },
      ],
      interaction: { kind: 'toggle' },
    },
  });
}

/** A static diagram in bands: what is above ground and what is below. */
export function layersDiagram(id: string): BlockOfType<'diagram'> {
  return finish<BlockOfType<'diagram'>>({
    id,
    type: 'diagram',
    version: 1,
    a11y: { label: 'Diagram: above and below ground' },
    fallbackText:
      'Above ground sit the deck and the towers; below ground sit the foundation and the soil that carries it all.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Above and below ground',
      layout: 'layers',
      nodes: [
        { id: 'l-deck', label: 'Deck', kind: 'entity', group: 'above' },
        { id: 'l-towers', label: 'Towers', kind: 'entity', group: 'above' },
        { id: 'l-found', label: 'Foundation', kind: 'process', group: 'below' },
        { id: 'l-soil', label: 'Soil', kind: 'store', group: 'below' },
      ],
      edges: [
        { id: 'l-1', from: 'l-deck', to: 'l-towers', directed: true, style: 'solid' },
        { id: 'l-2', from: 'l-towers', to: 'l-found', directed: true, style: 'solid' },
        { id: 'l-3', from: 'l-found', to: 'l-soil', directed: true, style: 'dashed' },
      ],
      groups: [
        { id: 'above', label: 'Above ground' },
        { id: 'below', label: 'Below ground' },
      ],
      frames: [],
      interaction: { kind: 'static' },
    },
  });
}

/** A static diagram on the 6 × 6 grid. */
export function gridDiagram(id: string): BlockOfType<'diagram'> {
  return finish<BlockOfType<'diagram'>>({
    id,
    type: 'diagram',
    version: 1,
    a11y: { label: 'Diagram: a truss' },
    fallbackText: 'Five joints on a grid, joined into a triangle on top of a base: the shape that keeps a truss stiff.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'A truss, joint by joint',
      layout: 'grid',
      nodes: [
        { id: 'g-a', label: 'A', kind: 'entity', cell: { column: 0, row: 4 } },
        { id: 'g-b', label: 'B', kind: 'entity', cell: { column: 5, row: 4 } },
        { id: 'g-c', label: 'C', kind: 'entity', cell: { column: 2, row: 1 } },
        { id: 'g-d', label: 'D', kind: 'entity', cell: { column: 3, row: 4 } },
        { id: 'g-e', label: 'E', kind: 'note', cell: { column: 1, row: 4 } },
      ],
      edges: [
        { id: 'g-ac', from: 'g-a', to: 'g-c', directed: false, style: 'solid', weight: 0.5 },
        { id: 'g-cb', from: 'g-c', to: 'g-b', directed: false, style: 'solid', weight: 0.5 },
        { id: 'g-ab', from: 'g-a', to: 'g-b', directed: false, style: 'solid', weight: 0.8 },
        { id: 'g-cd', from: 'g-c', to: 'g-d', directed: false, style: 'dashed', weight: 0.3 },
      ],
      groups: [],
      frames: [],
      interaction: { kind: 'static' },
    },
  });
}

export function barChart(id: string): BlockOfType<'chart'> {
  return finish<BlockOfType<'chart'>>({
    id,
    type: 'chart',
    version: 1,
    a11y: {
      label: 'Chart: how four designs score',
      description: 'Grouped bars: strength and cost for an arch, a beam, a truss and a cable design.',
    },
    fallbackText:
      'Four designs scored out of ten for strength and cost: arch 8 and 6, beam 5 and 3, truss 7 and 5, cable 9 and 8.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'How four designs score',
      caption: 'Scores are illustrative.',
      spec: {
        kind: 'bar',
        orientation: 'vertical',
        categories: ['Arch', 'Beam', 'Truss', 'Cable'],
        series: [
          { id: 'strength', label: 'Strength', values: [8, 5, 7, 9] },
          { id: 'cost', label: 'Cost', values: [6, 3, 5, 8] },
        ],
        valueAxis: { label: 'Score', unit: 'of 10', scale: 'linear' },
      },
    },
  });
}

export function horizontalBarChart(id: string): BlockOfType<'chart'> {
  return finish<BlockOfType<'chart'>>({
    id,
    type: 'chart',
    version: 1,
    a11y: { label: 'Chart: span by design' },
    fallbackText: 'Longest span by design in metres: beam 60, truss 120, arch 240 and suspension 1,000.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'How far each design reaches',
      spec: {
        kind: 'bar',
        orientation: 'horizontal',
        categories: ['Beam', 'Truss', 'Arch', 'Suspension'],
        series: [{ id: 'span', label: 'Span', values: [60, 120, 240, 1000] }],
        valueAxis: { label: 'Span', unit: 'm', scale: 'log' },
      },
    },
  });
}

export function lineChart(id: string): BlockOfType<'chart'> {
  return finish<BlockOfType<'chart'>>({
    id,
    type: 'chart',
    version: 1,
    a11y: { label: 'Chart: deck weight by span' },
    fallbackText: 'Deck weight in kilonewtons grows with span, faster for concrete than for steel.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Deck weight by span',
      caption: 'Illustrative numbers.',
      spec: {
        kind: 'line',
        x: { label: 'Span', unit: 'm', scale: 'linear' },
        y: { label: 'Weight', unit: 'kN', scale: 'linear' },
        series: [
          {
            id: 'steel',
            label: 'Steel',
            points: [
              [40, 740],
              [80, 1480],
              [120, 2220],
              [160, 2960],
            ],
          },
          {
            id: 'concrete',
            label: 'Concrete',
            points: [
              [40, 1100],
              [80, 2300],
              [120, 3600],
              [160, 5000],
            ],
          },
        ],
      },
    },
  });
}

export function scatterChart(id: string): BlockOfType<'chart'> {
  return finish<BlockOfType<'chart'>>({
    id,
    type: 'chart',
    version: 1,
    a11y: { label: 'Chart: inspection findings' },
    fallbackText:
      'Findings from a set of inspections: older bridges tend to have more findings, with a few exceptions.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Age and findings',
      spec: {
        kind: 'scatter',
        x: { label: 'Age', unit: 'years', scale: 'linear' },
        y: { label: 'Findings', scale: 'linear' },
        series: [
          {
            id: 'steel',
            label: 'Steel',
            points: [
              [5, 1],
              [20, 3],
              [35, 6],
              [60, 9],
            ],
          },
          {
            id: 'stone',
            label: 'Stone',
            points: [
              [40, 2],
              [90, 4],
              [140, 5],
              [200, 8],
            ],
          },
        ],
      },
    },
  });
}

export function heatmapChart(id: string): BlockOfType<'chart'> {
  return finish<BlockOfType<'chart'>>({
    id,
    type: 'chart',
    version: 1,
    a11y: {
      label: 'Chart: stress by part and weather',
      description: 'A grid of four parts against four kinds of weather; darker cells mean more stress.',
    },
    fallbackText:
      'Stress on the deck, cable, tower and ground under load, wind, ice and heat; the cable row is highlighted and is highest under load.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Where the stress goes',
      caption: 'The highlighted row is the cable.',
      spec: {
        kind: 'heatmap',
        rows: ['Deck', 'Cable', 'Tower', 'Ground'],
        columns: ['Load', 'Wind', 'Ice', 'Heat'],
        values: [
          [6, 3, 4, 2],
          [9, 5, 6, 3],
          [5, 4, 3, 2],
          [4, 2, 2, 1],
        ],
        scale: { label: 'Stress', min: 0, max: 10 },
        highlightRow: 1,
      },
    },
  });
}

export function pendulumSimulation(id: string): BlockOfType<'simulation'> {
  return simulation({
    id,
    type: 'simulation',
    version: 1,
    a11y: { label: 'Pendulum: swing time against string length' },
    fallbackText: 'A longer string swings more slowly: a one metre string takes about two seconds to swing once.',
    essential: true,
    gesture: 'none',
    data: {
      title: 'Try a longer string',
      params: [
        {
          key: 'length',
          label: 'String length',
          unit: 'm',
          min: 0.25,
          max: 4,
          step: 0.25,
          default: 1,
          control: 'slider',
          format: { decimals: 2, grouping: false, approximate: false },
        },
      ],
      constants: [],
      outputs: [
        {
          key: 'period',
          label: 'Swing time',
          unit: 's',
          formula: { kind: 'power', x: 'length', base: 1, exponent: 0.5, scale: 2.006 },
          format: one,
        },
      ],
      view: { kind: 'plot', x: 'length', y: 'period', yLabel: 'Swing time (s)' },
      readout: {
        template: 'A {length} m string swings once in about {period} s.',
        bands: [
          { output: 'period', max: 2, text: 'A quick swing.' },
          { output: 'period', min: 2, text: 'A slow, lazy swing.' },
        ],
      },
      modelNote: 'A simple model: small swings, no friction, a light string.',
      illustrative: { notice: 'Illustrative' },
    },
  });
}

export function floorSimulation(id: string): BlockOfType<'simulation'> {
  return simulation({
    id,
    type: 'simulation',
    version: 1,
    a11y: { label: 'Floor: area against side' },
    fallbackText:
      'Doubling the side of a square room makes the floor four times as big: three metres gives nine square metres.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Double the side',
      prompt: 'Move the slider and watch the square grow faster than the bar.',
      params: [
        {
          key: 'side',
          label: 'Room side',
          unit: 'm',
          min: 1,
          max: 10,
          step: 1,
          default: 3,
          control: 'slider',
          format: plain,
        },
      ],
      constants: [],
      outputs: [
        {
          key: 'floor',
          label: 'Floor area',
          unit: 'm²',
          formula: { kind: 'power', x: 'side', base: 1, exponent: 2, scale: 1 },
          format: grouped,
        },
      ],
      view: { kind: 'area', length: 'side', area: 'floor', lengthLabel: 'Side', areaLabel: 'Floor' },
      readout: { template: '{side} m on each side gives {floor} m² of floor.', bands: [] },
      modelNote: 'A square room with straight walls.',
      illustrative: { notice: 'Illustrative' },
    },
  });
}

export function altitudeSimulation(id: string): BlockOfType<'simulation'> {
  return simulation({
    id,
    type: 'simulation',
    version: 1,
    a11y: { label: 'Cooking: boiling point against altitude' },
    fallbackText:
      'Water boils at a lower temperature higher up: about one hundred degrees at sea level and a few degrees less at four kilometres.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Cook at your altitude',
      params: [
        {
          key: 'altitude',
          label: 'Your altitude',
          unit: 'm',
          min: 0,
          max: 4000,
          step: 250,
          default: 0,
          control: 'input',
          format: grouped,
          personal: true,
        },
      ],
      constants: [],
      outputs: [
        {
          key: 'boil',
          label: 'Water boils at',
          unit: '°C',
          formula: { kind: 'linear', x: 'altitude', a: -0.0033, b: 100 },
          format: one,
        },
        {
          key: 'simmer',
          label: 'A simmer is',
          unit: '°C',
          formula: { kind: 'linear', x: 'altitude', a: -0.0033, b: 92 },
          format: one,
        },
      ],
      view: {
        kind: 'cards',
        items: [
          { id: 'card-boil', label: 'Boiling point', output: 'boil', note: 'Less air pressure, a lower boil.' },
          { id: 'card-simmer', label: 'Gentle simmer', output: 'simmer' },
        ],
      },
      modelNote: 'A straight-line estimate over this range.',
      illustrative: { notice: 'Illustrative' },
    },
  });
}

export function interestSimulation(id: string): BlockOfType<'simulation'> {
  return simulation({
    id,
    type: 'simulation',
    version: 1,
    a11y: { label: 'Growth: an amount over the years' },
    fallbackText:
      'A starting amount of one hundred grows by four percent a year: after ten years it is about one hundred and fifty.',
    essential: false,
    gesture: 'none',
    data: {
      title: 'Let it grow',
      params: [
        {
          key: 'years',
          label: 'Years',
          unit: 'years',
          min: 1,
          max: 30,
          step: 1,
          default: 10,
          control: 'stepper',
          format: plain,
        },
      ],
      constants: [{ key: 'start', label: 'Starting amount', value: 100 }],
      outputs: [
        {
          key: 'total',
          label: 'Grown to',
          formula: { kind: 'exponential', x: 'years', rate: 0.04, initial: 'start' },
          format: grouped,
        },
        {
          key: 'doubling',
          label: 'Doubles after',
          unit: 'years',
          formula: { kind: 'ratio', numerator: 0.693, denominator: 0.04 },
          format: one,
        },
      ],
      view: { kind: 'readout', primary: 'total', secondary: 'doubling' },
      readout: { template: 'After {years} years, {start} grows to about {total}.', bands: [] },
      modelNote: 'Steady growth of four percent a year, with nothing added or taken out.',
      illustrative: { notice: 'Illustrative' },
    },
  });
}
