import { useEffect, type ReactNode } from 'react';
import {
  BLOCK_TYPES,
  BLOCK_VERSIONS,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  fallbackTextOf,
  type AnyBlock,
  type BlockType,
  type ClientCapabilities,
} from '../model';
import { useScrollRender } from '../context';
import { ChartView } from './chart/chart-view';
import { CodeView } from './code-view';
import { DiagramView } from './diagram/diagram-view';
import { FigureView, MediaView } from './media-views';
import { ComparisonView, TimelineView } from './narrative-views';
import { SequenceView } from './sequence-view';
import { SimulationView } from './simulation/simulation-view';
import { TableView } from './table-view';
import { FallbackView } from './fallback';
import { CalloutView, DisclosureView, ListView, ParagraphView, QuoteView, SubheadingView } from './text-blocks';

/**
 * The registry: which block types of scroll-document.v1 this build renders (all of them). A type
 * marked `false` would not be advertised to the server (`SCROLL_RENDERER_CAPABILITIES`), so the
 * server's negotiation would replace it with a `fallback` block, and a document that still carried
 * one renders its readable stand-in. Types must be listed explicitly: the compiler refuses a new
 * block type until it is decided here.
 */
const IMPLEMENTED = {
  paragraph: true,
  subheading: true,
  list: true,
  quote: true,
  callout: true,
  disclosure: true,
  code: true,
  table: true,
  figure: true,
  media: true,
  comparison: true,
  timeline: true,
  sequence: true,
  diagram: true,
  chart: true,
  simulation: true,
  fallback: true,
} as const satisfies Record<BlockType, boolean>;

export function isImplemented(type: BlockType): boolean {
  return IMPLEMENTED[type];
}

/** What the app tells the server it can render (`negotiate` substitutes the rest). */
export const SCROLL_RENDERER_CAPABILITIES: ClientCapabilities = {
  documentSchemas: [SCROLL_DOCUMENT_SCHEMA_VERSION],
  blocks: Object.fromEntries(
    BLOCK_TYPES.filter((type) => IMPLEMENTED[type]).map((type) => [type, [BLOCK_VERSIONS[type]]]),
  ),
};

/** A block the server replaced with a `fallback` block: its own readable text. */
function UnsupportedView({ block, originalType }: { block: AnyBlock; originalType: string }) {
  const context = useScrollRender();
  const blockId = block.id;
  const diagnose = context.diagnose;
  useEffect(() => {
    diagnose({ blockId, blockType: originalType, reason: 'unsupported-by-client' });
  }, [diagnose, blockId, originalType]);
  return <FallbackView blockType={originalType} text={fallbackTextOf(block)} cause="update" />;
}

export interface RenderOptions {
  /** The opening paragraph of an editorial essay gets a drop cap. */
  readonly initialCap?: boolean;
}

/** One block, drawn by the component registered for its type. */
export function renderBlock(block: AnyBlock, options: RenderOptions = {}): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <ParagraphView block={block} initialCap={options.initialCap === true} />;
    case 'subheading':
      return <SubheadingView block={block} />;
    case 'list':
      return <ListView block={block} />;
    case 'quote':
      return <QuoteView block={block} />;
    case 'callout':
      return <CalloutView block={block} />;
    case 'disclosure':
      return <DisclosureView block={block} />;
    case 'code':
      return <CodeView block={block} />;
    case 'fallback':
      return <UnsupportedView block={block} originalType={block.data.originalType} />;
    case 'table':
      return <TableView block={block} />;
    case 'figure':
      return <FigureView block={block} />;
    case 'media':
      return <MediaView block={block} />;
    case 'comparison':
      return <ComparisonView block={block} />;
    case 'timeline':
      return <TimelineView block={block} />;
    case 'sequence':
      return <SequenceView block={block} />;
    case 'diagram':
      return <DiagramView block={block} />;
    case 'chart':
      return <ChartView block={block} />;
    case 'simulation':
      return <SimulationView block={block} />;
  }
}
