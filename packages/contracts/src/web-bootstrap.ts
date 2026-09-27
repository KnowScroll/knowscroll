/**
 * #115 (evidence: #120/#121, ADR-0030): the desktop web client used to re-type the bootstrap
 * response shapes it parses by hand in `apps/web/src/api/types.ts`, disconnected from any shared
 * contract. When ADR-0030 added `recordingPausedAt` to `GET /v1/universe`, nothing forced that
 * hand-written client schema to grow the field too -- the client's `.strict()` schema rejected
 * every universe load against a healthy server, and both `apps/web`'s typecheck and its unit
 * tests stayed green throughout, because its hand-written fixtures agreed with its hand-written
 * schema while both silently disagreed with the server.
 *
 * These are the strict zod shapes for the bootstrap reads the web client parses --
 * `GET /v1/universe`, `GET /v1/feed` and `GET /v1/worlds` (docs/contracts/bootstrap-http.md) --
 * defined exactly once. `apps/web/src/api/types.ts` imports and re-exports them (the same
 * relative-import pattern it already uses for `./trace-revisit.ts` and `./index.ts`) instead of
 * redefining them, and `apps/web/test/unit/fakeApi.ts`'s fixtures (`universeOf`, `worldSystemOf`,
 * the feed-item builder) are typed against the `z.infer` types exported here. A field added to a
 * schema in this file without a matching fixture update now fails `apps/web` typecheck (an object
 * literal missing a required property) and, for the belt-and-suspenders runtime case, a strict
 * `.parse()` in `apps/web/test/unit/contractsDrift.test.ts` -- before it ever reaches production,
 * not after a journey run catches it.
 *
 * This file is new and self-contained (no import from `./index.ts` or `./worlds.ts`) so it never
 * needs to touch either of those existing files, which other work may also be changing.
 */
import { z } from 'zod';

export const capabilitiesSchema = z
  .object({ reasoning: z.boolean(), reels: z.boolean(), worldEvolution: z.boolean() })
  .strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const traceSchema = z
  .object({ eventId: z.string(), assetId: z.string(), title: z.string(), createdAt: z.string() })
  .strict();
export type Trace = z.infer<typeof traceSchema>;

/** `GET /v1/universe`. */
export const universeSchema = z
  .object({
    universeId: z.string(),
    revision: z.number(),
    privacyEpoch: z.number().int(),
    // ADR-0030 added this field to the wire response. It lives here, once, so a future field
    // addition/removal is felt by every consumer of this schema at the same time, not just by
    // whichever one someone remembered to update.
    recordingPausedAt: z.string().nullable(),
    traces: z.array(traceSchema),
    capabilities: capabilitiesSchema,
  })
  .strict();
export type Universe = z.infer<typeof universeSchema>;

/** The feed item extends the documented Scroll shape with a non-authoritative recommendation reason. */
export const feedItemSchema = z
  .object({
    assetId: z.string().uuid(),
    revision: z.number().int().positive(),
    kind: z.literal('Scroll'),
    title: z.string(),
    summary: z.string(),
    body: z.string(),
    sourceTitle: z.string(),
    sourceUrl: z.string().url(),
    truthState: z.string().min(1),
    reason: z.string(),
  })
  .strict();
export type FeedItem = z.infer<typeof feedItemSchema>;

/** `GET /v1/feed`. */
export const feedResponseSchema = z
  .object({
    decisionId: z.string(),
    universeId: z.string(),
    accountRevision: z.number(),
    privacyEpoch: z.number().int(),
    items: z.array(feedItemSchema),
  })
  .strict();
export type FeedResponse = z.infer<typeof feedResponseSchema>;

export const worldSummarySchema = z
  .object({
    worldId: z.string(),
    sourceTitle: z.string(),
    sourceUrl: z.string(),
    scrollCount: z.number().int().nonnegative(),
    seenCount: z.number().int().nonnegative(),
  })
  .strict();
export type WorldSummary = z.infer<typeof worldSummarySchema>;

/** `GET /v1/worlds`. */
export const worldSystemResponseSchema = z
  .object({
    derivationMethod: z.string(),
    // `null` for a universe whose own exposures have not yet reached any recorded source's
    // evidence -- never an empty object standing in for "nothing yet" (ADR-0028).
    system: z
      .object({ systemId: z.string(), worlds: z.array(worldSummarySchema) })
      .strict()
      .nullable(),
  })
  .strict();
export type WorldSystemResponse = z.infer<typeof worldSystemResponseSchema>;
