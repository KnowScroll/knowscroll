import { oc } from '@orpc/contract';
import { z } from 'zod';
import { AssetIdSchema, UuidSchema } from './ids.js';

export const ReelDocumentSchema = z.strictObject({
  schemaVersion: z.literal('reel-document.v1'),
  assetId: AssetIdSchema,
  revision: z.number().int().positive(),
  title: z.string().min(1).max(240),
  summary: z.string().max(2000),
  language: z.string().max(16),
  truthLabel: z.literal('generated'),
  fixture: z.boolean(),
  captions: z.literal('burned_in'),
  mediaKey: z.string().regex(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/),
  durationMs: z.number().int().min(20000).max(60000),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ReelDocument = z.infer<typeof ReelDocumentSchema>;

/** Mint/renew playback for an existing exposure. This is access, never new consumption evidence.
 * The URL is a short-lived credential: keep in memory and never log/cache/persist it. */
export const mediaGrantContract = oc
  .route({ method: 'POST', path: '/v1/media/grants', successStatus: 200, tags: ['media'] })
  .input(z.strictObject({ exposureId: UuidSchema }))
  .output(
    z.strictObject({
      document: ReelDocumentSchema,
      path: z.string().startsWith('/media/').max(3000),
      expiresAt: z.iso.datetime(),
    }),
  );
