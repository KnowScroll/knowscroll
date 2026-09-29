import { useEffect, useId, useRef, useState } from 'react';
import { webScrollArtifactV1 } from '../../../../packages/contracts/src/web-scroll-artifact.ts';
import './native-scroll.css';

/** A small, local rendering vocabulary. The server payload remains untrusted until parsed here. */
export type NativeScrollBlock =
  | { type: 'text'; heading?: string; paragraphs: string[] }
  | { type: 'disclosure'; label: string; body: string }
  | { type: 'comparison'; title: string; left: { label: string; points: string[] }; right: { label: string; points: string[] } }
  | { type: 'timeline'; title: string; events: Array<{ label: string; detail: string }> }
  | { type: 'diagram'; title: string; nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string; label?: string }> }
  | { type: 'visualization'; title: string; description: string; frequency: number };

export interface NativeScrollItem {
  assetId: string;
  revision?: number;
  title: string;
  body: string;
  truthState?: string;
  /** Preview-only authored blocks; the real feed uses the validated `webArtifact` below. */
  blocks?: unknown;
  webArtifact?: unknown;
}

export interface NativeScrollProps {
  item: NativeScrollItem;
  embedded?: boolean;
  onKeep?: () => void;
  keepLabel?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 1000): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const isTextList = (value: unknown, min = 1, max = 8): value is string[] =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every((entry) => isText(entry, 800));

function parseBlock(value: unknown): NativeScrollBlock | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'text':
      return isTextList(value.paragraphs, 1, 8) && (value.heading === undefined || isText(value.heading, 120))
        ? { type: 'text', ...(value.heading ? { heading: value.heading } : {}), paragraphs: value.paragraphs }
        : null;
    case 'disclosure':
      return isText(value.label, 120) && isText(value.body, 1800)
        ? { type: 'disclosure', label: value.label, body: value.body }
        : null;
    case 'comparison':
      if (!isText(value.title, 160) || !isRecord(value.left) || !isRecord(value.right)) return null;
      if (!isText(value.left.label, 100) || !isTextList(value.left.points, 1, 5)) return null;
      if (!isText(value.right.label, 100) || !isTextList(value.right.points, 1, 5)) return null;
      return { type: 'comparison', title: value.title, left: { label: value.left.label, points: value.left.points }, right: { label: value.right.label, points: value.right.points } };
    case 'timeline':
      if (!isText(value.title, 160) || !Array.isArray(value.events) || value.events.length < 2 || value.events.length > 8) return null;
      if (!value.events.every((event) => isRecord(event) && isText(event.label, 100) && isText(event.detail, 600))) return null;
      return { type: 'timeline', title: value.title, events: value.events as Array<{ label: string; detail: string }> };
    case 'diagram': {
      if (!isText(value.title, 160) || !Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 6) return null;
      if (!value.nodes.every((node) => isRecord(node) && /^[a-zA-Z0-9_-]{1,32}$/.test(String(node.id)) && isText(node.label, 100))) return null;
      const nodes = value.nodes as Array<{ id: string; label: string }>;
      const ids = new Set(nodes.map((node) => node.id));
      if (ids.size !== nodes.length || !Array.isArray(value.edges) || value.edges.length < 1 || value.edges.length > 10) return null;
      if (!value.edges.every((edge) => isRecord(edge) && typeof edge.from === 'string' && ids.has(edge.from) && typeof edge.to === 'string' && ids.has(edge.to) && (edge.label === undefined || isText(edge.label, 80)))) return null;
      return { type: 'diagram', title: value.title, nodes, edges: value.edges as Array<{ from: string; to: string; label?: string }> };
    }
    case 'visualization':
      return isText(value.title, 160) && isText(value.description, 500) && typeof value.frequency === 'number' && Number.isFinite(value.frequency) && value.frequency >= 0.5 && value.frequency <= 4
        ? { type: 'visualization', title: value.title, description: value.description, frequency: value.frequency }
        : null;
    default:
      return null;
  }
}

function bodyFallback(body: string): string[] {
  return body.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export function NativeScroll({ item, embedded = false, onKeep, keepLabel = 'Keep this Scroll' }: NativeScrollProps) {
  const parsedArtifact = item.webArtifact === null || item.webArtifact === undefined ? null : webScrollArtifactV1.safeParse(item.webArtifact);
  const artifactValid = parsedArtifact?.success && parsedArtifact.data.assetId === item.assetId && parsedArtifact.data.revision === item.revision;
  const artifactInvalid = parsedArtifact !== null && !artifactValid;
  const sourceBlocks = artifactValid ? parsedArtifact.data.blocks : item.webArtifact === undefined && Array.isArray(item.blocks) ? item.blocks : null;
  const blocks = sourceBlocks?.map(parseBlock) ?? [];
  const hasInvalidBlock = blocks.some((block) => block === null);
  const validBlocks = blocks.filter((block): block is NativeScrollBlock => block !== null);
  const paragraphs = sourceBlocks === null || hasInvalidBlock || validBlocks.length === 0 ? bodyFallback(item.body) : [];

  return (
    <section className={`native-scroll${embedded ? ' native-scroll--embedded' : ''}`} aria-label="Scroll content">
      {!embedded && <header className="native-scroll__header">
        <p className="native-scroll__eyebrow">A Scroll</p>
        <h1>{item.title}</h1>
        {item.truthState && <p className="native-scroll__state">{item.truthState}</p>}
      </header>}
      <div className="native-scroll__blocks">
        {paragraphs.map((paragraph, index) => <p className="native-scroll__prose" key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>)}
        {validBlocks.map((block, index) => <BlockView block={block} key={`${block.type}-${index}`} />)}
        {(hasInvalidBlock || artifactInvalid) && validBlocks.length > 0 && <p className="native-scroll__fallback" role="status">Part of this Scroll could not be displayed. The rest is still here.</p>}
        {artifactInvalid && validBlocks.length === 0 && <p className="native-scroll__fallback" role="status">This Scroll’s structured content is unavailable. Its text remains available.</p>}
        {sourceBlocks !== null && validBlocks.length === 0 && <p className="native-scroll__fallback" role="status">This Scroll’s structured content is unavailable. Its text remains available.</p>}
        {sourceBlocks === null && paragraphs.length === 0 && <p className="native-scroll__fallback" role="status">This Scroll has no readable text right now.</p>}
      </div>
      {onKeep && <div className="native-scroll__actions"><button type="button" onClick={onKeep}>{keepLabel}</button></div>}
    </section>
  );
}

function BlockView({ block }: { block: NativeScrollBlock }) {
  switch (block.type) {
    case 'text':
      return <section className="native-scroll__text-block">{block.heading && <h2>{block.heading}</h2>}{block.paragraphs.map((paragraph, index) => <p className="native-scroll__prose" key={index}>{paragraph}</p>)}</section>;
    case 'disclosure':
      return <details className="native-scroll__disclosure"><summary>{block.label}</summary><p>{block.body}</p></details>;
    case 'comparison':
      return <section className="native-scroll__comparison" aria-label={block.title}><h2>{block.title}</h2><div className="native-scroll__comparison-grid">{[block.left, block.right].map((side) => <div className="native-scroll__comparison-side" key={side.label}><h3>{side.label}</h3><ul>{side.points.map((point) => <li key={point}>{point}</li>)}</ul></div>)}</div></section>;
    case 'timeline':
      return <section className="native-scroll__timeline" aria-label={block.title}><h2>{block.title}</h2><ol>{block.events.map((event, index) => <li key={`${index}-${event.label}`}><span className="native-scroll__timeline-label">{event.label}</span><span>{event.detail}</span></li>)}</ol></section>;
    case 'diagram':
      return <Diagram block={block} />;
    case 'visualization':
      return <InteractivePlot block={block} />;
  }
}

function Diagram({ block }: { block: Extract<NativeScrollBlock, { type: 'diagram' }> }) {
  const markerId = `native-scroll-arrow-${useId().replace(/:/g, '')}`;
  const positions = block.nodes.map((_, index) => ({ x: 48 + index * (224 / Math.max(1, block.nodes.length - 1)), y: 72 + (index % 2) * 64 }));
  const positionById = new Map(block.nodes.map((node, index) => [node.id, positions[index]]));
  return <figure className="native-scroll__diagram"><figcaption>{block.title}</figcaption><svg viewBox="0 0 320 208" role="img" aria-label={block.title}>
    <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" /></marker></defs>
    {block.edges.map((edge, index) => { const from = positionById.get(edge.from)!; const to = positionById.get(edge.to)!; return <g key={index}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#${markerId})`} />{edge.label && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 7}>{edge.label}</text>}</g>; })}
    {block.nodes.map((node, index) => { const position = positions[index] ?? { x: 48, y: 72 }; return <g key={node.id} transform={`translate(${position.x}, ${position.y})`}><circle r="25" /><text textAnchor="middle" dominantBaseline="central">{node.label.slice(0, 18)}</text></g>; })}
  </svg><ul className="native-scroll__diagram-key">{block.nodes.map((node) => <li key={node.id}>{node.label}</li>)}</ul></figure>;
}

function InteractivePlot({ block }: { block: Extract<NativeScrollBlock, { type: 'visualization' }> }) {
  const [frequency, setFrequency] = useState(block.frequency);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const points = Array.from({ length: 9 }, (_, index) => Math.sin((index / 8) * Math.PI * 2 * frequency));

  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom has no canvas implementation; the adjacent data table is the full fallback.
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 560;
    const height = 180;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = '#8c907c';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(12, height / 2);
    context.lineTo(width - 12, height / 2);
    context.stroke();
    context.strokeStyle = '#2c46e8';
    context.lineWidth = 3;
    context.beginPath();
    for (let index = 0; index <= 80; index++) {
      const x = 12 + (index / 80) * (width - 24);
      const y = height / 2 - Math.sin((index / 80) * Math.PI * 2 * frequency) * (height * 0.36);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
  }, [frequency]);

  return <section className="native-scroll__plot" aria-label={block.title}>
    <h2>{block.title}</h2><p>{block.description}</p>
    <canvas ref={canvasRef} aria-hidden="true" />
    <label htmlFor={`plot-frequency-${slug(block.title)}`}>Wave cycles <output>{frequency.toFixed(1)}</output></label>
    <input id={`plot-frequency-${slug(block.title)}`} aria-label="Wave cycles" type="range" min="0.5" max="4" step="0.5" value={frequency} onChange={(event) => setFrequency(Number(event.currentTarget.value))} />
    <table className="native-scroll__plot-data"><caption>Sample values, available without the canvas</caption><thead><tr><th scope="col">Point</th><th scope="col">Value</th></tr></thead><tbody>{points.map((point, index) => <tr key={index}><th scope="row">{index + 1}</th><td>{point.toFixed(2)}</td></tr>)}</tbody></table>
  </section>;
}

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'chart'; }
