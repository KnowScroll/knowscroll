/** Public, declarative web representation of a checked Scroll. No source material or code. */
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const textList = (maxItems: number) => z.array(text(800)).min(1).max(maxItems);
const nodeId = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);

export const webScrollBlockV1 = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      heading: text(120).optional(),
      paragraphs: textList(8),
    })
    .strict(),
  z
    .object({
      type: z.literal('disclosure'),
      label: text(120),
      body: text(1800),
    })
    .strict(),
  z
    .object({
      type: z.literal('comparison'),
      title: text(160),
      left: z.object({ label: text(100), points: textList(5) }).strict(),
      right: z.object({ label: text(100), points: textList(5) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('timeline'),
      title: text(160),
      events: z
        .array(z.object({ label: text(100), detail: text(600) }).strict())
        .min(2)
        .max(8),
    })
    .strict(),
  z
    .object({
      type: z.literal('diagram'),
      title: text(160),
      nodes: z
        .array(z.object({ id: nodeId, label: text(100) }).strict())
        .min(2)
        .max(6),
      edges: z
        .array(
          z
            .object({ from: nodeId, to: nodeId, label: text(80).optional() })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      type: z.literal('visualization'),
      title: text(160),
      description: text(500),
      frequency: z.number().min(0.5).max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal('code'),
      title: text(160),
      language: z.enum(['javascript', 'typescript', 'python', 'text']),
      code: text(3200),
      caption: text(300).optional(),
    })
    .strict(),
]);
export type WebScrollBlockV1 = z.infer<typeof webScrollBlockV1>;

export const webScrollArtifactV1 = z
  .object({
    schemaVersion: z.literal(1),
    level: z.literal('declarative'),
    assetId: z.string().uuid(),
    revision: z.number().int().positive(),
    blocks: z.array(webScrollBlockV1).min(1).max(24),
    accessibility: z.object({ title: text(160) }).strict(),
    provenance: z
      .object({
        kind: z.enum(['checked_model_scroll', 'authored_test_fixture']),
        generation: z.literal('complete'),
        validation: z.literal('passed'),
      })
      .strict(),
    fallbackBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
    integritySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WebScrollArtifactV1 = z.infer<typeof webScrollArtifactV1>;
