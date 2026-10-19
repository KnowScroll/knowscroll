import { z } from 'zod';
import { FIELD_LIMITS } from '../limits.js';
import { BlockTypeName, BlockVersionNumber, plainText } from '../primitives.js';
import { ChartData } from './chart.js';
import { DiagramData } from './diagram.js';
import { defineBlock } from './envelope.js';
import { ComparisonData, SequenceData, TimelineData } from './narrative.js';
import { CodeData, FigureData, MediaData, TableData } from './reference.js';
import { SimulationData } from './simulation.js';
import { CalloutData, ListData, ParagraphData, QuoteData, SubheadingData } from './text.js';

/** Emitted only by `negotiate` in place of a block the client cannot render. Never authored. */
export const FallbackData = z.strictObject({
  originalType: BlockTypeName,
  originalVersion: BlockVersionNumber,
  reason: z.enum(['unsupported-by-client']),
});

/** A reveal whose children are plain reading blocks (no interactive blocks inside). */
export function disclosureData<B extends z.ZodType>(child: B) {
  return z.strictObject({
    summary: plainText(1, FIELD_LIMITS.disclosureSummaryChars),
    blocks: z.array(child).min(1).max(FIELD_LIMITS.disclosureBlocks),
  });
}

export const ParagraphBlock = defineBlock('paragraph', ParagraphData);
export const SubheadingBlock = defineBlock('subheading', SubheadingData);
export const ListBlock = defineBlock('list', ListData);
export const QuoteBlock = defineBlock('quote', QuoteData);
export const CalloutBlock = defineBlock('callout', CalloutData);
export const CodeBlock = defineBlock('code', CodeData);
export const TableBlock = defineBlock('table', TableData);
export const FigureBlock = defineBlock('figure', FigureData);
export const MediaBlock = defineBlock('media', MediaData);
export const ComparisonBlock = defineBlock('comparison', ComparisonData);
export const TimelineBlock = defineBlock('timeline', TimelineData);
export const SequenceBlock = defineBlock('sequence', SequenceData);
export const DiagramBlock = defineBlock('diagram', DiagramData);
export const ChartBlock = defineBlock('chart', ChartData);
export const SimulationBlock = defineBlock('simulation', SimulationData);
export const FallbackBlock = defineBlock('fallback', FallbackData);

/** Blocks allowed inside a disclosure. */
export const NestedBlock = z.discriminatedUnion('type', [
  ParagraphBlock,
  ListBlock,
  QuoteBlock,
  CalloutBlock,
  CodeBlock,
  TableBlock,
  FigureBlock,
  FallbackBlock,
]);
export type NestedBlock = z.infer<typeof NestedBlock>;
export const NESTABLE_BLOCK_TYPES = ['paragraph', 'list', 'quote', 'callout', 'code', 'table', 'figure'] as const;

export const DisclosureBlock = defineBlock('disclosure', disclosureData(NestedBlock));

/** Every block of scroll-document.v1: 16 authored types plus the server-emitted `fallback`. */
export const Block = z.discriminatedUnion('type', [
  ParagraphBlock,
  SubheadingBlock,
  ListBlock,
  QuoteBlock,
  CalloutBlock,
  DisclosureBlock,
  CodeBlock,
  TableBlock,
  FigureBlock,
  MediaBlock,
  ComparisonBlock,
  TimelineBlock,
  SequenceBlock,
  DiagramBlock,
  ChartBlock,
  SimulationBlock,
  FallbackBlock,
]);
export type Block = z.infer<typeof Block>;
/** A block anywhere in a document, top level or inside a disclosure. */
export type AnyBlock = Block | NestedBlock;
export type BlockType = Block['type'];
export type BlockOfType<T extends BlockType> = Extract<Block, { type: T }>;

export const BLOCK_TYPES = [
  'paragraph',
  'subheading',
  'list',
  'quote',
  'callout',
  'disclosure',
  'code',
  'table',
  'figure',
  'media',
  'comparison',
  'timeline',
  'sequence',
  'diagram',
  'chart',
  'simulation',
  'fallback',
] as const satisfies readonly BlockType[];

/** Types a producer may write. `fallback` is reserved for negotiation. */
export const AUTHORED_BLOCK_TYPES = BLOCK_TYPES.filter(
  (type): type is Exclude<BlockType, 'fallback'> => type !== 'fallback',
);
export type AuthoredBlockType = Exclude<BlockType, 'fallback'>;

/** The version of every block type this package implements. */
export const BLOCK_VERSIONS: { readonly [T in BlockType]: number } = Object.freeze(
  Object.fromEntries(BLOCK_TYPES.map((type) => [type, 1])) as { [T in BlockType]: number },
);

const KNOWN_TYPES: ReadonlySet<string> = new Set(BLOCK_TYPES);
export function isBlockType(type: string): type is BlockType {
  return KNOWN_TYPES.has(type);
}

/** Data schema per authored type (shared with the producer's draft schema). */
export const AUTHORED_DATA_SCHEMAS = {
  paragraph: ParagraphData,
  subheading: SubheadingData,
  list: ListData,
  quote: QuoteData,
  callout: CalloutData,
  code: CodeData,
  table: TableData,
  figure: FigureData,
  media: MediaData,
  comparison: ComparisonData,
  timeline: TimelineData,
  sequence: SequenceData,
  diagram: DiagramData,
  chart: ChartData,
  simulation: SimulationData,
} as const;
