/** Deterministic artifact authoring and delivery validation; never executes generated code. */
import { createHash } from 'node:crypto';
import {
  webScrollArtifactV1,
  type WebScrollArtifactV1,
} from '../../../contracts/src/web-scroll-artifact.ts';

const MAX_ARTIFACT_BYTES = 65_536;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** JSONB does not preserve object insertion order. Hash a stable JSON tree so
 * the persisted representation has the same digest as the authored one. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createCheckedScrollWebArtifact(input: {
  assetId: string;
  revision: number;
  title: string;
  beats: readonly string[];
  body: string;
}): WebScrollArtifactV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    level: 'declarative' as const,
    assetId: input.assetId,
    revision: input.revision,
    blocks: input.beats.map((beat) => ({
      type: 'text' as const,
      paragraphs: [beat],
    })),
    accessibility: { title: input.title },
    provenance: {
      kind: 'checked_model_scroll' as const,
      generation: 'complete' as const,
      validation: 'passed' as const,
    },
    fallbackBodySha256: hash(input.body),
  };
  const artifact = webScrollArtifactV1.parse({
    ...unsigned,
    integritySha256: hash(canonicalJson(unsigned)),
  });
  if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_ARTIFACT_BYTES)
    throw new Error('web_artifact_oversized');
  return artifact;
}

/** Invalid, stale or future artifacts fall back to the checked body; they never break feed delivery. */
export function validateScrollWebArtifact(
  value: unknown,
  input: { assetId: string; revision: number; body: string },
): WebScrollArtifactV1 | null {
  const parsed = webScrollArtifactV1.safeParse(value);
  if (!parsed.success) return null;
  const artifact = parsed.data;
  if (
    Buffer.byteLength(JSON.stringify(artifact)) > MAX_ARTIFACT_BYTES ||
    artifact.assetId !== input.assetId ||
    artifact.revision !== input.revision ||
    artifact.fallbackBodySha256 !== hash(input.body)
  )
    return null;
  const { integritySha256, ...unsigned } = artifact;
  if (integritySha256 !== hash(canonicalJson(unsigned))) return null;
  for (const block of artifact.blocks) {
    if (block.type !== 'diagram') continue;
    const ids = new Set(block.nodes.map((node) => node.id));
    if (
      ids.size !== block.nodes.length ||
      block.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
    )
      return null;
  }
  return artifact;
}
