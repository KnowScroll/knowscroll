/**
 * fast-check generators of valid scroll-document.v1 content, for property tests only (CI
 * fixtures). Generated text uses a fixed vocabulary without digits, including non-ASCII words
 * and a surrogate pair so UTF-16 offsets are exercised. Simulations use positive parameters,
 * positive constants and structural literals only, so their outputs stay finite and positive.
 */
import fc from 'fast-check';
import {
  computeIntegrity,
  computeMeasures,
  deriveGesture,
  INTEGRITY_METHOD,
  isInteractiveBlock,
  LIMITS,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  SCROLL_LIMITS_VERSION,
  type AnyBlock,
  type Block,
  type BlockOfType,
  type BlockType,
  type Formula,
  type NestedBlock,
  type Operand,
  type ScrollDocument,
  type Section,
  type SimulationData,
  type Span,
} from '../index.js';

const WORDS = [
  'the',
  'moon',
  'pulls',
  'ocean',
  'word',
  'attention',
  'grid',
  'light',
  'river',
  'stone',
  'slow',
  'quick',
  'bright',
  'map',
  'field',
  'wave',
  'orbit',
  'scale',
  'tide',
  'share',
  'caf\u00e9',
  'na\u00efve',
  '\u201cit\u201d',
  '\u{1F30D}',
] as const;

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One sentence of `min`–`max` words, capitalised, ending with a full stop. */
export function sentence(min = 2, max = 12): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...WORDS), { minLength: min, maxLength: max })
    .map((words) => `${capitalise(words.join(' '))}.`);
}

/** A short label of 1–`maxWords` words. */
export function label(maxWords = 3): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: maxWords }).map((words) => words.join(' '));
}

/** Inline text of 1–`parts` sentences, some marked. */
export function spans(parts = 3): fc.Arbitrary<Span[]> {
  return fc
    .array(
      fc.record({
        text: sentence(),
        marks: fc.option(fc.subarray(['em', 'strong', 'code'] as const, { minLength: 1 }), { nil: undefined }),
      }),
      { minLength: 1, maxLength: parts },
    )
    .map((items) =>
      items.map((item, index) => {
        const text = index === 0 ? item.text : ` ${item.text}`;
        return item.marks === undefined ? { text } : { text, marks: [...item.marks] };
      }),
    );
}

/** A block of `type` with a generic envelope and the gesture derived from its data. */
export function make<T extends BlockType>(type: T, data: BlockOfType<T>['data'], essential = false): BlockOfType<T> {
  const block = {
    id: 'pending',
    type,
    version: 1,
    a11y: { label: type },
    fallbackText: `Text version of this ${type}, standing on its own for every reader.`,
    essential,
    gesture: 'none',
    data,
  } as BlockOfType<T>;
  return { ...block, gesture: deriveGesture(block) };
}

const mediaRef = fc.integer({ min: 1, max: 5 }).map((n) => ({ mediaId: `med-${n}`, revision: 1 }));
const alt = sentence(4, 10);

export const paragraphBlock = spans().map((value) => make('paragraph', { spans: value }));
export const subheadingBlock = label(5).map((text) => make('subheading', { text: capitalise(text) }));
export const listBlock = fc
  .record({ style: fc.constantFrom('bullet', 'number'), items: fc.array(spans(1), { minLength: 2, maxLength: 8 }) })
  .map((data) => make('list', data));
export const quoteBlock = fc
  .record({
    kind: fc.constantFrom('pull', 'quotation'),
    text: spans(2),
    attribution: fc.option(label(3), { nil: undefined }),
  })
  .map(({ kind, text, attribution }) =>
    make(
      'quote',
      kind === 'quotation' && attribution !== undefined ? { kind, spans: text, attribution } : { kind, spans: text },
    ),
  );
export const calloutBlock = fc
  .record({
    kind: fc.constantFrom('note', 'example', 'limit', 'key-idea', 'try-it'),
    title: fc.option(label(4).map(capitalise), { nil: undefined }),
    text: spans(2),
  })
  .map(({ kind, title, text }) =>
    make('callout', title === undefined ? { kind, spans: text } : { kind, title, spans: text }),
  );
export const codeBlock = fc
  .array(
    fc.array(fc.constantFrom('value', 'total', 'step', 'scale', '+', '=', '(', ')'), { minLength: 1, maxLength: 12 }),
    {
      minLength: 1,
      maxLength: 12,
    },
  )
  .chain((lines) =>
    fc.record({
      language: fc.constantFrom('python', 'typescript', 'text'),
      highlight: fc.option(fc.integer({ min: 1, max: lines.length }), { nil: undefined }),
      lines: fc.constant(lines),
    }),
  )
  .map(({ language, highlight, lines }) =>
    make('code', {
      language,
      code: lines.map((line) => line.join(' ')).join('\n'),
      ...(highlight === undefined ? {} : { highlightLines: [highlight] }),
    }),
  );
export const tableBlock = fc
  .record({
    columns: fc.integer({ min: 1, max: LIMITS.tableColumns }),
    rows: fc.integer({ min: 1, max: LIMITS.tableRows }),
  })
  .chain(({ columns, rows }) =>
    fc.record({
      columns: fc.array(fc.record({ label: label(2), align: fc.constantFrom('start', 'end') }), {
        minLength: columns,
        maxLength: columns,
      }),
      rows: fc.array(
        fc.array(fc.oneof(label(2), fc.integer({ min: -999, max: 999 }), fc.constant('')), {
          minLength: columns,
          maxLength: columns,
        }),
        { minLength: rows, maxLength: rows },
      ),
      caption: label(5),
      rowHeader: fc.boolean(),
    }),
  )
  .map((data) => make('table', data));
export const figureBlock = fc
  .record({
    media: mediaRef,
    motion: fc.constantFrom('still', 'loop'),
    alt,
    caption: fc.option(sentence(), { nil: undefined }),
  })
  .map(({ caption, ...data }) => make('figure', caption === undefined ? data : { ...data, caption }));
export const mediaBlock = fc
  .record({
    kind: fc.constantFrom('video', 'audio'),
    media: mediaRef,
    poster: mediaRef,
    captions: mediaRef,
    alt,
    transcript: sentence(3, 30),
  })
  .map(({ kind, poster, captions, ...rest }) =>
    make(
      'media',
      kind === 'video' ? { kind, poster, captions, durationMs: 12_000, ...rest } : { kind, durationMs: 8_000, ...rest },
    ),
  );
export const comparisonBlock = fc
  .record({
    title: label(4),
    columns: fc.array(fc.record({ label: label(2), points: fc.array(spans(1), { minLength: 1, maxLength: 5 }) }), {
      minLength: 2,
      maxLength: 3,
    }),
  })
  .map((data) => make('comparison', data));
export const timelineBlock = fc
  .record({
    title: label(4),
    events: fc.array(fc.record({ when: label(2), title: label(3) }), { minLength: 2, maxLength: 12 }),
  })
  .map(({ title, events }) =>
    make('timeline', { title, events: events.map((event, index) => ({ id: `event-${index}`, ...event })) }),
  );
export const sequenceBlock = fc
  .record({
    title: label(4),
    steps: fc.array(
      fc.record({
        title: label(3),
        text: spans(2),
        figure: fc.option(fc.record({ media: mediaRef, alt }), { freq: 4, nil: undefined }),
      }),
      {
        minLength: 2,
        maxLength: 8,
      },
    ),
  })
  .map(({ title, steps }) =>
    make('sequence', {
      title,
      steps: steps.map(({ text, figure, ...step }, index) => ({
        id: `step-${index}`,
        ...step,
        spans: text,
        ...(figure === undefined ? {} : { figure }),
      })),
    }),
  );

export const diagramBlock = fc
  .record({
    nodes: fc.integer({ min: 3, max: LIMITS.diagramNodes }),
    kind: fc.constantFrom('static', 'steps', 'toggle', 'drag-to-target'),
    grid: fc.boolean(),
    essential: fc.boolean(),
  })
  .chain(({ nodes, kind, grid, essential }) => {
    const pairs: Array<[number, number]> = [];
    for (let from = 0; from < nodes; from += 1)
      for (let to = 0; to < nodes; to += 1) if (from !== to) pairs.push([from, to]);
    const targetCount = Math.min(6, nodes - 1);
    return fc.record({
      labels: fc.array(label(2), { minLength: nodes, maxLength: nodes }),
      edges: fc.uniqueArray(fc.constantFrom(...pairs), {
        maxLength: LIMITS.diagramEdges,
        selector: ([from, to]) => `${from}-${to}`,
      }),
      frames: fc.integer({ min: kind === 'drag-to-target' ? targetCount : 2, max: LIMITS.diagramFrames }),
      frameLabels: fc.array(fc.record({ label: label(2), description: sentence(3, 12) }), {
        minLength: LIMITS.diagramFrames,
        maxLength: LIMITS.diagramFrames,
      }),
      targets: fc.integer({ min: 2, max: targetCount }),
      constant: fc.constant({ nodes, kind, grid, essential }),
    });
  })
  .map(({ labels, edges, frames, frameLabels, targets, constant }) => {
    const { nodes, kind, grid, essential } = constant;
    const nodeList = labels.map((nodeLabel, index) => ({
      id: `node-${index}`,
      label: nodeLabel,
      kind: index === 0 && kind === 'drag-to-target' ? ('token' as const) : ('entity' as const),
      ...(grid ? { cell: { column: index % 6, row: Math.floor(index / 6) } } : {}),
    }));
    const edgeList = edges.map(([from, to], index) => ({
      id: `edge-${index}`,
      from: `node-${from}`,
      to: `node-${to}`,
      directed: true,
      style: 'solid' as const,
      weight: ((index % 10) + 1) / 10,
    }));
    const frameCount = kind === 'static' ? 0 : frames;
    const frameList = frameLabels.slice(0, frameCount).map((frame, index) => ({
      id: `frame-${index}`,
      label: frame.label,
      description: `This frame shows ${frame.description}`,
      emphasis: [`node-${(index + 1) % nodes}`],
      hidden: [],
      weights: edgeList.slice(0, 1).map((edge) => ({ edge: edge.id, weight: 0.5 })),
    }));
    const interaction =
      kind === 'drag-to-target'
        ? {
            kind,
            token: 'node-0',
            targets: Array.from({ length: Math.min(targets, frameCount) }, (_, index) => ({
              node: `node-${index + 1}`,
              frame: `frame-${index}`,
            })),
            initialFrame: 'frame-0',
          }
        : { kind };
    return make(
      'diagram',
      {
        title: 'Diagram',
        layout: grid ? 'grid' : 'radial',
        nodes: nodeList,
        edges: edgeList,
        groups: [],
        frames: frameList,
        interaction,
      },
      essential,
    );
  });

export const chartBlock = fc.oneof(
  fc
    .record({ categories: fc.integer({ min: 1, max: 24 }), series: fc.integer({ min: 1, max: 4 }) })
    .filter(({ categories, series }) => categories * series <= LIMITS.chartPoints)
    .chain(({ categories, series }) =>
      fc.record({
        categories: fc.array(label(1), { minLength: categories, maxLength: categories }),
        values: fc.array(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: categories, maxLength: categories }), {
          minLength: series,
          maxLength: series,
        }),
      }),
    )
    .map(({ categories, values }) =>
      make('chart', {
        title: 'Bars',
        spec: {
          kind: 'bar',
          orientation: 'vertical',
          categories,
          series: values.map((row, index) => ({
            id: `series-${index}`,
            label: `series ${'abcd'.charAt(index)}`,
            values: row,
          })),
          valueAxis: { label: 'Amount', scale: 'linear', domain: [0, 100] },
        },
      }),
    ),
  fc
    .record({
      kind: fc.constantFrom('line', 'scatter'),
      series: fc.array(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 1, max: 50 })), {
          minLength: 1,
          maxLength: 50,
        }),
        {
          minLength: 1,
          maxLength: 4,
        },
      ),
    })
    .map(({ kind, series }) =>
      make('chart', {
        title: 'Points',
        spec: {
          kind,
          x: { label: 'Across', scale: 'linear' },
          y: { label: 'Up', scale: 'log' },
          series: series.map((points, index) => ({ id: `series-${index}`, label: 'series', points })),
        },
      }),
    ),
  fc
    .record({ rows: fc.integer({ min: 1, max: 12 }), columns: fc.integer({ min: 1, max: 12 }) })
    .chain(({ rows, columns }) =>
      fc.record({
        values: fc.array(
          fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: columns, maxLength: columns }),
          {
            minLength: rows,
            maxLength: rows,
          },
        ),
        rowLabels: fc.array(label(1), { minLength: rows, maxLength: rows }),
        columnLabels: fc.array(label(1), { minLength: columns, maxLength: columns }),
      }),
    )
    .map(({ values, rowLabels, columnLabels }) =>
      make('chart', {
        title: 'Grid',
        spec: {
          kind: 'heatmap',
          rows: rowLabels,
          columns: columnLabels,
          values,
          scale: { label: 'Weight', min: 0, max: 1 },
        },
      }),
    ),
);

const STRUCTURAL = [1, 2, 0.5] as const;

/** A simulation whose outputs are finite and positive for every parameter value. */
export const simulationData: fc.Arbitrary<SimulationData> = fc
  .record({
    params: fc.array(
      fc.record({
        min: fc.integer({ min: 1, max: 10 }),
        step: fc.constantFrom(1, 2, 5, 0.5),
        positions: fc.integer({ min: 1, max: 60 }),
        at: fc.nat(),
        control: fc.constantFrom('slider', 'stepper', 'input'),
        personal: fc.boolean(),
        label: label(3),
      }),
      { minLength: 1, maxLength: LIMITS.paramsPerBlock },
    ),
    constants: fc.array(fc.double({ min: 0.5, max: 10, noNaN: true }), { maxLength: 3 }),
    outputs: fc.array(
      fc.record({
        kind: fc.constantFrom('linear', 'product', 'ratio', 'power', 'exponential', 'inverse-square', 'lookup'),
        picks: fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
        exponent: fc.constantFrom(-2, -1, 0.5, 1, 2, 3),
        mode: fc.constantFrom('step', 'interpolate'),
      }),
      { minLength: 1, maxLength: 6 },
    ),
    view: fc.constantFrom('readout', 'cards', 'plot', 'area'),
    illustrative: fc.boolean(),
  })
  .map(({ params, constants, outputs, view, illustrative }) => {
    const paramList = params.map((param, index) => {
      const max = param.min + param.step * param.positions;
      return {
        key: `p${index}`,
        label: param.label,
        min: param.min,
        max,
        step: param.step,
        default: param.min + param.step * (param.at % (param.positions + 1)),
        control: param.control,
        format: { decimals: 1, grouping: true, approximate: false },
        ...(param.personal ? { personal: true as const } : {}),
      };
    });
    const constantList = constants.map((value, index) => ({ key: `c${index}`, label: `constant ${index}`, value }));
    const keys = [...paramList.map((param) => param.key), ...constantList.map((constant) => constant.key)];
    const pick = (n: number): Operand => {
      const choice = n % (keys.length + STRUCTURAL.length);
      return choice < keys.length ? (keys[choice] ?? 1) : (STRUCTURAL[choice - keys.length] ?? 1);
    };
    const pickParam = (n: number) => paramList[n % paramList.length]?.key ?? 'p0';
    /** Constants (at most 10) and structural literals only: keeps exponentials bounded. */
    const pickSmall = (n: number): Operand => {
      const small = [...constantList.map((constant) => constant.key), ...STRUCTURAL];
      return small[n % small.length] ?? 1;
    };
    const formulaFor = (output: (typeof outputs)[number]): Formula => {
      const [a = 0, b = 0, c = 0, d = 0] = output.picks;
      switch (output.kind) {
        case 'linear':
          return { kind: 'linear', x: pick(a), a: pick(b), b: pick(c) };
        case 'product':
          return { kind: 'product', factors: [pick(a), pick(b), pick(c)] };
        case 'ratio':
          return { kind: 'ratio', numerator: pick(a), denominator: pickParam(b) };
        case 'power':
          return { kind: 'power', x: pickParam(a), base: pick(b), exponent: output.exponent, scale: pick(c) };
        case 'exponential':
          return {
            kind: 'exponential',
            x: pickSmall(a),
            rate: STRUCTURAL[b % STRUCTURAL.length] ?? 1,
            initial: pick(c),
          };
        case 'inverse-square':
          return { kind: 'inverse-square', r: pickParam(a), k: pick(b) };
        case 'lookup':
          return {
            kind: 'lookup',
            input: pickParam(a),
            mode: output.mode,
            table: [
              { at: 0, value: pick(b) },
              { at: 10, value: pick(c) },
              { at: 50, value: pick(d) },
            ],
          };
      }
    };
    const outputList = outputs.map((output, index) => ({
      key: `o${index}`,
      label: `output ${index}`,
      formula: formulaFor(output),
      format: { decimals: 2, grouping: true, approximate: true },
    }));
    const first = outputList[0]?.key ?? 'o0';
    const viewSpec: SimulationData['view'] =
      view === 'readout'
        ? { kind: 'readout', primary: first }
        : view === 'cards'
          ? {
              kind: 'cards',
              barMax: 100,
              items: [
                { id: 'card-a', label: 'first', output: first },
                { id: 'card-b', label: 'last', output: outputList[outputList.length - 1]?.key ?? first },
              ],
            }
          : view === 'plot'
            ? { kind: 'plot', x: 'p0', y: first, yLabel: 'value', yDomain: [0, 1e15] }
            : { kind: 'area', length: 'p0', area: first, lengthLabel: 'length', areaLabel: 'area' };
    return {
      title: 'Try it',
      params: paramList,
      constants: constantList,
      outputs: outputList,
      view: viewSpec,
      readout: { template: `{${first}} for {p0}`, bands: [{ output: first, min: 1, text: 'At least one.' }] },
      modelNote: 'Generated for a property test.',
      illustrative,
    };
  });

export const simulationBlock = fc
  .tuple(simulationData, fc.boolean())
  .map(([data, essential]) => make('simulation', data, essential));

const nestedBlock: fc.Arbitrary<NestedBlock> = fc.oneof(
  paragraphBlock,
  listBlock,
  quoteBlock,
  calloutBlock,
  codeBlock,
  tableBlock,
  figureBlock,
);
export const disclosureBlock = fc
  .record({ summary: label(4), blocks: fc.array(nestedBlock, { minLength: 1, maxLength: 6 }) })
  .map((data) => make('disclosure', data));

/** Any authored block, interactive ones less often. */
export const anyBlock: fc.Arbitrary<Block> = fc.oneof(
  { arbitrary: paragraphBlock, weight: 6 },
  { arbitrary: subheadingBlock, weight: 1 },
  { arbitrary: listBlock, weight: 1 },
  { arbitrary: quoteBlock, weight: 1 },
  { arbitrary: calloutBlock, weight: 1 },
  { arbitrary: disclosureBlock, weight: 1 },
  { arbitrary: codeBlock, weight: 1 },
  { arbitrary: tableBlock, weight: 1 },
  { arbitrary: figureBlock, weight: 1 },
  { arbitrary: mediaBlock, weight: 1 },
  { arbitrary: comparisonBlock, weight: 1 },
  { arbitrary: timelineBlock, weight: 1 },
  { arbitrary: sequenceBlock, weight: 1 },
  { arbitrary: diagramBlock, weight: 2 },
  { arbitrary: chartBlock, weight: 1 },
  { arbitrary: simulationBlock, weight: 2 },
);

/** Gives every section and block a unique id, keeps interactive blocks and parameters within limits. */
export function arrange(sections: ReadonlyArray<{ heading: string; blocks: readonly Block[] }>): Section[] {
  let interactive = 0;
  let params = 0;
  let counter = 0;
  const filler = (): Block => make('paragraph', { spans: [{ text: 'A quiet paragraph stands in here.' }] });
  const withId = <B extends AnyBlock>(block: B): B => {
    counter += 1;
    return { ...block, id: `block-${counter}` };
  };
  return sections.map((section, sectionIndex) => ({
    id: `section-${sectionIndex}`,
    heading: sectionIndex === 0 ? null : capitalise(section.heading),
    blocks: section.blocks.map((original) => {
      let block = original;
      const blockParams = block.type === 'simulation' ? block.data.params.length : 0;
      if (isInteractiveBlock(block)) {
        if (interactive >= LIMITS.interactiveBlocks || params + blockParams > LIMITS.paramsTotal) block = filler();
        else {
          interactive += 1;
          params += blockParams;
        }
      }
      const placed = withId(block);
      if (placed.type !== 'disclosure') return placed;
      return { ...placed, data: { ...placed.data, blocks: placed.data.blocks.map((child) => withId(child)) } };
    }),
  }));
}

/** Completes sections into a stored revision: measures and integrity computed by code. */
export function seal(
  sections: Section[],
  overrides: Partial<Omit<ScrollDocument, 'sections' | 'measures' | 'integrity'>> = {},
): ScrollDocument {
  const unsigned: Omit<ScrollDocument, 'integrity'> = {
    schemaVersion: SCROLL_DOCUMENT_SCHEMA_VERSION,
    assetId: 'generated-scroll',
    revision: 1,
    language: 'en',
    explanationUnitId: 'generated-unit',
    template: 'poster',
    theme: { family: 'systems' },
    kicker: 'Generated',
    title: 'A generated Scroll',
    dek: 'Made by a property test, not a writer.',
    framing: { kind: 'factual' },
    corrections: [],
    limitsVersion: SCROLL_LIMITS_VERSION,
    ...overrides,
    sections,
    measures: computeMeasures(sections),
  };
  return { ...unsigned, integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrity(unsigned) } };
}

/** A valid stored document of 1–`maxSections` sections. */
export function scrollDocument(maxSections = 4, maxBlocks = 6): fc.Arbitrary<ScrollDocument> {
  return fc
    .array(fc.record({ heading: label(4), blocks: fc.array(anyBlock, { minLength: 1, maxLength: maxBlocks }) }), {
      minLength: 1,
      maxLength: maxSections,
    })
    .map((sections) => seal(arrange(sections)));
}
