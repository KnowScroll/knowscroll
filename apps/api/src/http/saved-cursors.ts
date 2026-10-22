import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SavedPageCursorSchema, SavedPageFilterSchema } from '@knowscroll/contracts';
import type { SavedCursorBinding, SavedCursorCodec } from '@knowscroll/backend/modules/experience';

/** Versioned server policy, not a retained library lease. Restart/instance changes require Refresh. */
export const SAVED_CURSOR_TTL_MS = 5 * 60000;
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Claims = z.strictObject({
  purpose: z.literal('saved-page.v1'),
  world: z.string().min(1).max(300),
  accountId: z.uuid(),
  universeId: z.uuid(),
  privacyEpoch: Counter.min(1),
  filter: SavedPageFilterSchema,
  limit: z.number().int().min(1).max(50),
  after: z.strictObject({
    assetId: z.uuid(),
    savedAt: z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  }),
  issued: Counter,
  expires: Counter,
});
const sameBinding = (a: SavedCursorBinding, b: SavedCursorBinding) =>
  a.accountId.toLowerCase() === b.accountId.toLowerCase() &&
  a.universeId.toLowerCase() === b.universeId.toLowerCase() &&
  a.privacyEpoch === b.privacyEpoch &&
  a.filter === b.filter &&
  a.limit === b.limit;

/** Own random key per factory/API instance; deliberately separate from media grants. No env,
 * table, private-scope key or multi-instance portability. Authentication AND confidentiality.
 * Failures return only undefined: no plaintext, rejected token or crypto error is logged. */
export function savedCursors(world: string, now = () => Date.now()): SavedCursorCodec {
  const key = randomBytes(32),
    aad = Buffer.from(`knowscroll:saved-page.v1:${world}`);
  return {
    mint(binding, after) {
      const issued = now(),
        claims = Claims.parse({
          ...binding,
          after,
          purpose: 'saved-page.v1',
          world,
          issued,
          expires: issued + SAVED_CURSOR_TTL_MS,
        });
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
      return SavedPageCursorSchema.parse(
        `ksp1_${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')}`,
      );
    },
    read(binding, token) {
      if (!SavedPageCursorSchema.safeParse(token).success) return undefined;
      try {
        const raw = Buffer.from(token.slice(5), 'base64url');
        if (raw.length < 29 || raw.toString('base64url') !== token.slice(5)) return undefined;
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(raw.subarray(-16));
        const text = Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8');
        const claims = Claims.parse(JSON.parse(text)),
          time = now();
        if (
          claims.world !== world ||
          !sameBinding(binding, claims) ||
          claims.issued > time ||
          claims.expires <= time ||
          claims.expires - claims.issued !== SAVED_CURSOR_TTL_MS
        )
          return undefined;
        return claims.after;
      } catch {
        return undefined;
      }
    },
  };
}
