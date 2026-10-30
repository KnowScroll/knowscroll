import { BLOCK_TYPES } from '@knowscroll/scroll-model';
import { z } from 'zod';
import { READING_UNIT_TYPES } from './reading-facts-v2.js';
import { READING_FACTS_V3_VERSION, READING_FACTS_VERSION, type ReadingFacts } from '../domain/reading-facts.js';

const measuresVersion = z.string().regex(/^[a-z][a-z0-9.-]{1,39}$/);

/** Reading facts of a v1 document or a Reel. */
const ReadingFactsV2Schema = z.object({
  v: z.literal(READING_FACTS_VERSION),
  reelDurationMs: z.number().int().min(20000).max(60000).optional(),
  measuresVersion,
  totalWeight: z.number().int().min(0),
  estimatedReadingMs: z.number().int().min(0),
  blocks: z.array(z.object({ id: z.string(), weight: z.number().int().min(0), type: z.enum(BLOCK_TYPES) })).max(2_000),
  nested: z.array(z.object({ id: z.string(), owner: z.string(), type: z.enum(BLOCK_TYPES) })).max(2_000),
});

/** How a v2 unit counts as read: visible long enough, or a call locked in or revealed. */
const SeenRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('visible'), minVisibleMs: z.number().int().min(500).max(120_000) }),
  z.strictObject({ kind: z.literal('interaction'), interactions: z.array(z.string().min(1).max(40)).min(1).max(4) }),
]);

/** Reading facts of a `scroll-document.v2`: its stops and calls, each with its own rule, nothing nested. */
const ReadingFactsV3Schema = z.object({
  v: z.literal(READING_FACTS_V3_VERSION),
  measuresVersion,
  totalWeight: z.number().int().min(0),
  estimatedReadingMs: z.number().int().min(0),
  blocks: z
    .array(
      z.object({
        id: z.string(),
        weight: z.number().int().min(0),
        type: z.enum(READING_UNIT_TYPES),
        seen: SeenRuleSchema,
      }),
    )
    .max(64),
  nested: z.tuple([]),
});

/** Validates stored derived facts at content's adapter boundary, against the canonical block registry. */
export const ReadingFactsSchema = z.discriminatedUnion('v', [
  ReadingFactsV2Schema,
  ReadingFactsV3Schema,
]) satisfies z.ZodType<ReadingFacts>;
