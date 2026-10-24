import type { RosterCertificate, RosterCursorCodec } from '../application/ports.js';

const KINDS = ['friends', 'incoming', 'outgoing', 'blocked'] as const;
const VERSION = 1;
const SIZE = 1 + 1 + 1 + 16 + 16 + 4 + 8 + 16 + 8 + 8;
const MAX_TRAVERSAL_MS = 5 * 60 * 1000;

const toBytes = (uuid: string) => Buffer.from(uuid.replaceAll('-', ''), 'hex');
function fromBytes(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A stateless keyset cursor over one roster traversal: the filter, the roster's head revision, the
 * last person ID scanned, the caller's own account, universe and epoch, and the traversal's time window.
 *
 * It holds no key, so it survives restarts and works on every API instance. It also needs none:
 * the person ID is a public identifier from the caller's own roster, the use case compares every
 * field with the caller's current scope and head before it reads, and a cursor that was forged or
 * copied can only start the caller's own roster scan somewhere else. Any roster change moves the
 * head and ends the traversal, and the time window ends it by itself after five minutes or at the
 * first pending request deadline, whichever is earlier.
 */
export function rosterCursorCodec(): RosterCursorCodec {
  return {
    encode(certificate) {
      const bytes = Buffer.alloc(SIZE);
      let offset = 0;
      bytes[offset++] = VERSION;
      bytes[offset++] = KINDS.indexOf(certificate.filter);
      bytes[offset++] = certificate.limit;
      toBytes(certificate.accountId).copy(bytes, offset);
      offset += 16;
      toBytes(certificate.universeId).copy(bytes, offset);
      offset += 16;
      bytes.writeUInt32BE(certificate.epoch, offset);
      offset += 4;
      bytes.writeBigUInt64BE(BigInt(certificate.revision), offset);
      offset += 8;
      toBytes(certificate.after).copy(bytes, offset);
      offset += 16;
      bytes.writeBigUInt64BE(BigInt(certificate.started), offset);
      offset += 8;
      bytes.writeBigUInt64BE(BigInt(certificate.until), offset);
      return bytes.toString('base64url');
    },
    decode(token) {
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
      const bytes = Buffer.from(token, 'base64url');
      // One position has exactly one spelling.
      if (bytes.length !== SIZE || bytes.toString('base64url') !== token || bytes[0] !== VERSION) return undefined;
      const filter = KINDS[bytes[1]!];
      if (!filter) return undefined;
      const certificate: RosterCertificate = {
        filter,
        limit: bytes[2]!,
        accountId: fromBytes(bytes.subarray(3, 19)),
        universeId: fromBytes(bytes.subarray(19, 35)),
        epoch: bytes.readUInt32BE(35),
        revision: Number(bytes.readBigUInt64BE(39)),
        after: fromBytes(bytes.subarray(47, 63)),
        started: Number(bytes.readBigUInt64BE(63)),
        until: Number(bytes.readBigUInt64BE(71)),
      };
      const valid =
        Number.isSafeInteger(certificate.revision) &&
        certificate.revision >= 1 &&
        Number.isSafeInteger(certificate.started) &&
        Number.isSafeInteger(certificate.until) &&
        certificate.limit >= 1 &&
        certificate.limit <= 50 &&
        certificate.until > certificate.started &&
        certificate.until - certificate.started <= MAX_TRAVERSAL_MS;
      return valid ? certificate : undefined;
    },
  };
}
