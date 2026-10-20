import { BLOCK_TYPES } from '@knowscroll/scroll-model';
import { z } from 'zod';
import { READING_FACTS_VERSION, type ReadingFacts } from '../domain/reading-facts.js';

/** Validates stored derived facts at content's adapter boundary, against the canonical block registry. */
export const ReadingFactsSchema = z.object({
  v: z.literal(READING_FACTS_VERSION),
  measuresVersion: z.string().regex(/^[a-z][a-z0-9.-]{1,39}$/),
  totalWeight: z.number().int().min(0),
  estimatedReadingMs: z.number().int().min(0),
  blocks: z.array(z.object({ id: z.string(), weight: z.number().int().min(0), type: z.enum(BLOCK_TYPES) })).max(2_000),
  nested: z.array(z.object({ id: z.string(), owner: z.string(), type: z.enum(BLOCK_TYPES) })).max(2_000),
}) satisfies z.ZodType<ReadingFacts>;
