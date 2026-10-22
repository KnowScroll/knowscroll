import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { RosterCertificate, RosterCursorCodec } from '../application/ports.js';
const kinds = ['friends', 'incoming', 'outgoing', 'blocked'] as const;
const uuid = (s: string) => Buffer.from(s.replaceAll('-', ''), 'hex');
function fromUuid(b: Buffer) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Process-private authenticated binary certificate; restart refuses old traversals uniformly.
 * No token contains a readable peer/private root, timestamp, revision or raw received value. */
export function rosterCursorCodec(): RosterCursorCodec {
  const key = randomBytes(32),
    aad = Buffer.from('social.roster.cursor.v2');
  return {
    encode(c) {
      const b = Buffer.alloc(95);
      b[0] = 1;
      uuid(c.accountId).copy(b, 1);
      uuid(c.universeId).copy(b, 17);
      b.writeUInt32BE(c.epoch, 33);
      b.writeBigUInt64BE(BigInt(c.revision), 37);
      b[45] = kinds.indexOf(c.filter);
      b[46] = c.limit;
      uuid(c.after).copy(b, 47);
      uuid(c.ceiling).copy(b, 79);
      b.writeDoubleBE(c.until, 63);
      b.writeDoubleBE(c.started, 71);
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      return Buffer.concat([iv, cipher.update(b), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    },
    decode(token) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
        const b = Buffer.from(token, 'base64url');
        if (b.length !== 123 || b.toString('base64url') !== token) return undefined;
        const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(b.subarray(-16));
        const p = Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]);
        const filter = kinds[p[45]!];
        if (p[0] !== 1 || !filter) return undefined;
        const c: RosterCertificate = {
          accountId: fromUuid(p.subarray(1, 17)),
          universeId: fromUuid(p.subarray(17, 33)),
          epoch: p.readUInt32BE(33),
          revision: Number(p.readBigUInt64BE(37)),
          filter,
          limit: p[46]!,
          after: fromUuid(p.subarray(47, 63)),
          ceiling: fromUuid(p.subarray(79, 95)),
          until: p.readDoubleBE(63),
          started: p.readDoubleBE(71),
        };
        if (
          !Number.isSafeInteger(c.revision) ||
          c.revision < 1 ||
          !Number.isSafeInteger(c.until) ||
          !Number.isSafeInteger(c.started) ||
          c.limit < 1 ||
          c.limit > 50 ||
          c.until <= c.started ||
          c.until - c.started > 300000 ||
          c.after >= c.ceiling
        )
          return undefined;
        return c;
      } catch {
        return undefined;
      }
    },
  };
}
