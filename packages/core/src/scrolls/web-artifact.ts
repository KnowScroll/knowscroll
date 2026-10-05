/** Deterministic artifact authoring and delivery validation; never executes generated code. */
import { createHash } from 'node:crypto';
import {
  type WebScrollArtifactV1,
  type WebScrollBlockV1,
  webScrollArtifactV1,
} from '@knowscroll/contracts/web-scroll-artifact';

const MAX_ARTIFACT_BYTES = 65_536;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** JSONB does not preserve object insertion order. Hash a stable JSON tree so
 * the persisted representation has the same digest as the authored one. Not `shared/canonical-json`: this
 * drops `undefined` members and sorts keys with `localeCompare`, and stored digests depend on that. */
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

function sealArtifact(input: {
  assetId: string;
  revision: number;
  title: string;
  body: string;
  blocks: WebScrollBlockV1[];
  provenanceKind: WebScrollArtifactV1['provenance']['kind'];
}): WebScrollArtifactV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    level: 'declarative' as const,
    assetId: input.assetId,
    revision: input.revision,
    blocks: input.blocks,
    accessibility: { title: input.title },
    provenance: {
      kind: input.provenanceKind,
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

export function createCheckedScrollWebArtifact(input: {
  assetId: string;
  revision: number;
  title: string;
  beats: readonly string[];
  body: string;
}): WebScrollArtifactV1 {
  return sealArtifact({
    assetId: input.assetId,
    revision: input.revision,
    title: input.title,
    body: input.body,
    blocks: input.beats.map((beat) => ({ type: 'text', paragraphs: [beat] })),
    provenanceKind: 'checked_model_scroll',
  });
}

/** Only disposable preview/test setup calls this. It cannot claim model checking or production publication. */
export function createAuthoredTestScrollWebArtifact(input: {
  assetId: string;
  revision: number;
  title: string;
  body: string;
  blocks: WebScrollBlockV1[];
}): WebScrollArtifactV1 {
  return sealArtifact({ ...input, provenanceKind: 'authored_test_fixture' });
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
