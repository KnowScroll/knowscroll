import type { Issue } from '../issues.js';
import { FIELD_LIMITS } from '../limits.js';
import { gridPositions } from '../simulation/evaluate.js';
import { truncateText } from '../text.js';
import type { AuthoredBlock, AuthoredScroll } from './authoring-schema.js';
import type { DraftBlock, ScrollDraft } from './draft.js';

/**
 * The evidence handles each block cites, by position: `blockCites[section][block]`. A canonical
 * draft has no place for them, so the converter returns them beside it and the binder turns them
 * into claim bindings once the document is assembled.
 */
export interface ConvertedScroll {
  readonly draft: ScrollDraft;
  readonly blockCites: readonly (readonly (readonly string[])[])[];
}

export type Conversion =
  | ({ readonly kind: 'converted' } & ConvertedScroll)
  | { readonly kind: 'refused'; readonly issues: readonly Issue[] };

type Authored<T extends AuthoredBlock['type']> = Extract<AuthoredBlock, { type: T }>;

/** One line of plain text: runs of whitespace (line breaks and tabs included) become one space. */
const oneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const fit = (value: string, max: number): string => truncateText(oneLine(value), max);
const spans = (value: string) => [{ text: oneLine(value) }];

/** A document-local id (`^[a-z][a-z0-9-]{1,39}$`) made from any text, and unique among `used`. */
function localId(raw: string, fallback: string, used: Set<string>): string {
  let base = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!/^[a-z]/u.test(base)) base = base === '' ? fallback : `${fallback}-${base}`;
  base = base.slice(0, 36).replace(/-+$/u, '');
  if (base.length < 2) base = fallback;
  let id = base;
  for (let attempt = 2; used.has(id); attempt += 1) id = `${base}-${attempt}`;
  used.add(id);
  return id;
}

/** The accessibility label and standalone fallback text every non-text block carries, built from its own words. */
function envelope(title: string, fallback: string, kind: string) {
  const text = oneLine(fallback);
  const padded =
    text.length >= FIELD_LIMITS.fallbackTextMinChars ? text : `${text} This ${kind} is described here in words.`;
  return {
    a11y: { label: fit(title, FIELD_LIMITS.a11yLabelChars) },
    fallbackText: truncateText(padded, FIELD_LIMITS.fallbackTextChars),
  };
}

function diagram(block: Authored<'diagram'>, path: string, issues: Issue[]): DraftBlock {
  const used = new Set<string>();
  const nodes = block.nodes.map((node) => ({ ...node, id: localId(node.id ?? node.label, 'node', used) }));
  const nodeByName = new Map<string, string>();
  for (const node of nodes) {
    nodeByName.set(node.id, node.id);
    nodeByName.set(localId(node.label, 'node', new Set()), node.id);
  }
  const nodeOf = (name: string): string | undefined => nodeByName.get(localId(name, 'node', new Set()));

  const edges = block.edges.map((edge, index) => {
    const from = nodeOf(edge.from);
    const to = nodeOf(edge.to);
    if (from === undefined) issues.push({ code: 'authoring_reference_unknown', path: `${path}.edges.${index}.from` });
    if (to === undefined) issues.push({ code: 'authoring_reference_unknown', path: `${path}.edges.${index}.to` });
    return {
      ...edge,
      from: from ?? '',
      to: to ?? '',
      id: localId(edge.id ?? `${edge.from}-${edge.to}`, 'edge', used),
    };
  });
  const edgeByName = new Map<string, string>();
  for (const edge of edges) {
    edgeByName.set(edge.id, edge.id);
    edgeByName.set(`${edge.from}>${edge.to}`, edge.id);
  }
  /** A frame names a node or edge by id or label, or an edge as `from>to`. */
  const elementOf = (name: string, at: string): string[] => {
    const direct = nodeOf(name) ?? edgeByName.get(localId(name, 'edge', new Set()));
    if (direct !== undefined) return [direct];
    const [left, right] = name.split(/\s*-?>\s*/u);
    const from = left === undefined ? undefined : nodeOf(left);
    const to = right === undefined ? undefined : nodeOf(right);
    const found = from !== undefined && to !== undefined ? edgeByName.get(`${from}>${to}`) : undefined;
    if (found === undefined) {
      issues.push({ code: 'authoring_reference_unknown', path: at });
      return [];
    }
    return [found];
  };

  const title = fit(block.title, 100);
  const frames = block.frames.map((frame, index) => ({
    id: localId(frame.label, 'frame', used),
    label: fit(frame.label, 40),
    description: fit(frame.description, FIELD_LIMITS.frameDescriptionChars),
    emphasis: (frame.highlight ?? []).flatMap((name, at) =>
      elementOf(name, `${path}.frames.${index}.highlight.${at}`),
    ),
    hidden: (frame.hide ?? []).flatMap((name, at) => elementOf(name, `${path}.frames.${index}.hide.${at}`)),
    weights: [],
  }));
  const fallback = `${title}. ${frames.map((frame) => `${frame.label}: ${frame.description}`).join(' ')}`;
  return {
    type: 'diagram',
    ...envelope(title, fallback, 'diagram'),
    data: {
      title,
      ...(block.instruction === undefined ? {} : { instruction: fit(block.instruction, 120) }),
      layout: block.layout ?? 'flow-lr',
      nodes: nodes.map((node) => ({
        id: node.id,
        label: fit(node.label, FIELD_LIMITS.diagramLabelChars),
        kind: node.kind ?? 'entity',
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        ...(edge.label === undefined ? {} : { label: fit(edge.label, FIELD_LIMITS.diagramLabelChars) }),
        directed: true,
        style: edge.dashed === true ? ('dashed' as const) : ('solid' as const),
      })),
      groups: [],
      frames,
      interaction: { kind: block.interaction ?? 'toggle' },
    },
  };
}

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

/** Decimal places of a step such as 0.25, at most the display limit of four. */
function decimalsOf(step: number): number {
  for (let places = 0; places < 4; places += 1)
    if (Math.abs(step * 10 ** places - Math.round(step * 10 ** places)) < 1e-9) return places;
  return 4;
}

/**
 * A model rarely lands its maximum and default exactly on its own grid. The simulation is
 * illustrative, so code aligns them: the maximum becomes the last grid value at or below it and
 * the default the nearest grid value. A parameter without a usable grid is left for the
 * canonical check to refuse.
 */
function aligned(param: { min: number; max: number; step: number; default: number }) {
  const positions = gridPositions(param);
  if (!(param.step > 0) || !(param.min < param.max) || !Number.isFinite(positions)) return param;
  const max = round(param.min + Math.floor(positions + 1e-9) * param.step);
  const inside = Math.min(Math.max(param.default, param.min), max);
  return { ...param, max, default: round(param.min + Math.round((inside - param.min) / param.step) * param.step) };
}

function simulation(block: Authored<'simulation'>): DraftBlock {
  const format = (decimals: number) => ({ decimals, grouping: false, approximate: false });
  const title = fit(block.title, 100);
  const first = block.outputs[0];
  const firstParam = block.params[0];
  const view =
    block.view === 'plot' && first !== undefined && firstParam !== undefined
      ? { kind: 'plot' as const, x: firstParam.key, y: first.key, yLabel: fit(first.label, 40) }
      : block.view === 'cards' && block.outputs.length >= 2
        ? {
            kind: 'cards' as const,
            items: block.outputs.map((output, index) => ({
              id: `card-${index + 1}`,
              label: fit(output.label, 32),
              output: output.key,
            })),
          }
        : {
            kind: 'readout' as const,
            primary: first?.key ?? '',
            ...(block.outputs[1] === undefined ? {} : { secondary: block.outputs[1].key }),
          };
  const note = fit(block.note, 240);
  return {
    type: 'simulation',
    ...envelope(title, `${title}. ${block.prompt ?? ''} ${note}`, 'simulation'),
    data: {
      title,
      ...(block.prompt === undefined ? {} : { prompt: fit(block.prompt, 120) }),
      params: block.params.map((authored) => {
        const param = aligned(authored);
        return {
          key: authored.key,
          label: fit(authored.label, 60),
          ...(authored.unit === undefined ? {} : { unit: fit(authored.unit, 16) }),
          min: param.min,
          max: param.max,
          step: param.step,
          default: param.default,
          control: 'slider' as const,
          format: format(decimalsOf(param.step)),
        };
      }),
      constants: (block.constants ?? []).map((constant) => ({
        key: constant.key,
        label: fit(constant.label, 60),
        value: constant.value,
        ...(constant.unit === undefined ? {} : { unit: fit(constant.unit, 16) }),
      })),
      outputs: block.outputs.map((output) => ({
        key: output.key,
        label: fit(output.label, 60),
        ...(output.unit === undefined ? {} : { unit: fit(output.unit, 16) }),
        formula: output.formula,
        format: format(output.decimals ?? 1),
      })),
      view,
      ...(block.readout === undefined ? {} : { readout: { template: oneLine(block.readout), bands: [] } }),
      modelNote: note,
      // A model-authored simulation is a teaching model: its numbers are choices, and the reader is told.
      illustrative: true,
    },
  };
}

function chart(block: Authored<'bar-chart'> | Authored<'line-chart'>): DraftBlock {
  const title = fit(block.title, 100);
  const caption = block.caption === undefined ? {} : { caption: fit(block.caption, FIELD_LIMITS.captionChars) };
  const axis = (label: string, unit: string | undefined) => ({
    label: fit(label, 40),
    ...(unit === undefined ? {} : { unit: fit(unit, 16) }),
    scale: 'linear' as const,
  });
  if (block.type === 'bar-chart') {
    const categories = block.categories.map((category) => fit(category, 24));
    const series = block.series.map((entry, index) => ({
      id: `series-${index + 1}`,
      label: fit(entry.label, 40),
      values: entry.values,
    }));
    const summary = `${title}. ${block.caption ?? ''} A bar chart of ${series.map((entry) => entry.label).join(', ')} by ${categories.join(', ')}.`;
    return {
      type: 'chart',
      ...envelope(title, summary, 'chart'),
      data: {
        title,
        ...caption,
        spec: {
          kind: 'bar',
          orientation: block.horizontal === true ? 'horizontal' : 'vertical',
          categories,
          series,
          valueAxis: axis(block.axisLabel, block.axisUnit),
        },
      },
    };
  }
  const series = block.series.map((entry, index) => ({
    id: `series-${index + 1}`,
    label: fit(entry.label, 40),
    points: entry.points,
  }));
  const summary = `${title}. ${block.caption ?? ''} A line chart of ${series.map((entry) => entry.label).join(', ')} against ${fit(block.xLabel, 40)}.`;
  return {
    type: 'chart',
    ...envelope(title, summary, 'chart'),
    data: {
      title,
      ...caption,
      spec: { kind: 'line', x: axis(block.xLabel, block.xUnit), y: axis(block.yLabel, block.yUnit), series },
    },
  };
}

function convertBlock(block: AuthoredBlock, path: string, issues: Issue[]): DraftBlock {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', data: { spans: spans(block.text) } };
    case 'list':
      return { type: 'list', data: { style: block.style ?? 'bullet', items: block.items.map(spans) } };
    case 'callout':
      return {
        type: 'callout',
        data: {
          kind: block.kind,
          ...(block.title === undefined ? {} : { title: fit(block.title, FIELD_LIMITS.calloutTitleChars) }),
          spans: spans(block.text),
        },
      };
    case 'comparison': {
      const title = fit(block.title, 100);
      const columns = block.columns.map((column) => ({
        label: fit(column.label, 60),
        points: column.points.map(spans),
      }));
      const summary = block.columns
        .map((column) => `${oneLine(column.label)}: ${column.points.map(oneLine).join('; ')}`)
        .join(' ');
      return { type: 'comparison', ...envelope(title, `${title}. ${summary}`, 'comparison'), data: { title, columns } };
    }
    case 'timeline': {
      const title = fit(block.title, 100);
      const events = block.events.map((event, index) => ({
        id: `event-${index + 1}`,
        when: fit(event.when, 32),
        title: fit(event.title, 80),
        ...(event.detail === undefined ? {} : { detail: spans(event.detail) }),
      }));
      const summary = events.map((event) => `${event.when}: ${event.title}`).join('; ');
      return { type: 'timeline', ...envelope(title, `${title}. ${summary}`, 'timeline'), data: { title, events } };
    }
    case 'sequence': {
      const title = fit(block.title, 100);
      const steps = block.steps.map((step, index) => ({
        id: `step-${index + 1}`,
        title: fit(step.title, 80),
        spans: spans(step.text),
      }));
      const summary = block.steps.map((step) => `${oneLine(step.title)}: ${oneLine(step.text)}`).join(' ');
      return { type: 'sequence', ...envelope(title, `${title}. ${summary}`, 'sequence'), data: { title, steps } };
    }
    case 'diagram':
      return diagram(block, path, issues);
    case 'bar-chart':
    case 'line-chart':
      return chart(block);
    case 'simulation':
      return simulation(block);
  }
}

/**
 * Converts an authored document into a canonical `ScrollDraft` without bindings. Pure: strings
 * become one-span rich text, accessibility labels and fallback texts are built from the block's
 * own words, ids are generated, simulation grids are aligned and diagram references are resolved.
 * A reference that names nothing is a finding at its path; every other rule is the canonical
 * checks' business.
 */
export function convertAuthored(authored: AuthoredScroll): Conversion {
  const issues: Issue[] = [];
  const blockCites: string[][][] = [];
  const sections = authored.sections.map((section, sectionIndex) => {
    blockCites.push(section.blocks.map((block) => [...new Set(block.cites)]));
    return {
      heading:
        section.heading === undefined || section.heading === null
          ? null
          : fit(section.heading, FIELD_LIMITS.headingChars),
      blocks: section.blocks.map((block, blockIndex) =>
        convertBlock(block, `sections.${sectionIndex}.blocks.${blockIndex}`, issues),
      ),
    };
  });
  if (issues.length > 0) return { kind: 'refused', issues };
  return {
    kind: 'converted',
    draft: {
      draftVersion: 'scroll-draft.v1',
      title: fit(authored.title, FIELD_LIMITS.titleChars),
      dek: fit(authored.dek, FIELD_LIMITS.dekChars),
      sections,
      bindings: [],
    },
    blockCites,
  };
}
