import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Caller } from './callers.js';

const claimSchema = z.strictObject({
  v: z.literal(1),
  audience: z.string().max(100),
  session: z.string().max(100),
  account: z.uuid(),
  universe: z.uuid(),
  epoch: z.number().int().nonnegative(),
  exposure: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  issued: z.number().int(),
  expires: z.number().int(),
});
/** One API instance/world. Restart rotates the random signing key and invalidates all grants. */
export function mediaGrants(audience: string, now = () => Date.now()) {
  const secret = randomBytes(32);
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest();
  return {
    mint(caller: Caller, exposure: string, sha256: string) {
      const issued = now();
      const expires = issued + 60000;
      const body = Buffer.from(
        JSON.stringify({
          v: 1,
          audience,
          session: caller.sessionId,
          account: caller.accountId,
          universe: caller.universeId,
          epoch: caller.privacyEpoch,
          exposure,
          sha256,
          issued,
          expires,
        }),
      ).toString('base64url');
      return { token: `${body}.${sign(body).toString('base64url')}`, expiresAt: new Date(expires).toISOString() };
    },
    verify(token: unknown, caller: Caller) {
      if (typeof token !== 'string' || token.length > 2000) return undefined;
      const parts = token.split('.');
      const body = parts[0];
      const mac = parts[1];
      if (parts.length !== 2 || !body || !mac || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(mac))
        return undefined;
      const signature = Buffer.from(mac, 'base64url');
      const expected = sign(body);
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined;
      try {
        const claim = claimSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
        const time = now();
        if (
          claim.audience !== audience ||
          claim.session !== caller.sessionId ||
          claim.account !== caller.accountId ||
          claim.universe !== caller.universeId ||
          claim.epoch !== caller.privacyEpoch ||
          claim.issued > time ||
          claim.expires <= time ||
          claim.expires - claim.issued !== 60000
        )
          return undefined;
        return claim;
      } catch {
        return undefined;
      }
    },
  };
}
