/**
 * Keyset positions for the two discussion reads. A cursor is a short base64url record of where the
 * last page ended: it carries nothing the caller does not already hold and grants nothing, because
 * every read rechecks the caller's membership. No key is involved, so cursors survive restarts and
 * work across API instances. A position that belongs to another discussion is refused as stale.
 */

import { UUID_BYTES, uuidFromBytes, uuidToBytes } from './uuid-bytes.js';

const VERSION = 1;

export interface HistoryPosition {
  readonly discussionId: string;
  /** The oldest message sequence the caller already has; the page holds older ones. */
  readonly beforeSequence: number;
}
export interface ChangesPosition {
  readonly discussionId: string;
  /** The last change sequence the caller has seen; the page holds newer ones. */
  readonly afterChangeSequence: number;
}

function encode(prefix: string, fields: { readonly number: number; readonly uuid: string }): string {
  const bytes = Buffer.alloc(1 + 8 + UUID_BYTES);
  bytes[0] = VERSION;
  bytes.writeBigUInt64BE(BigInt(fields.number), 1);
  uuidToBytes(fields.uuid).copy(bytes, 9);
  return `${prefix}_${bytes.toString('base64url')}`;
}

function decode(prefix: string, token: string): { readonly number: number; readonly uuid: string } | undefined {
  if (!token.startsWith(`${prefix}_`)) return undefined;
  const body = token.slice(prefix.length + 1);
  const bytes = Buffer.from(body, 'base64url');
  // Reject non-canonical spellings so one position has exactly one token.
  if (bytes.length !== 1 + 8 + UUID_BYTES || bytes.toString('base64url') !== body || bytes[0] !== VERSION)
    return undefined;
  const number = Number(bytes.readBigUInt64BE(1));
  if (!Number.isSafeInteger(number)) return undefined;
  return { number, uuid: uuidFromBytes(bytes.subarray(9)) };
}

export const historyCursor = {
  encode: (position: HistoryPosition) =>
    encode('krh1', { number: position.beforeSequence, uuid: position.discussionId }),
  decode(token: string): HistoryPosition | undefined {
    const fields = decode('krh1', token);
    return fields && { discussionId: fields.uuid, beforeSequence: fields.number };
  },
};

export const changesCursor = {
  encode: (position: ChangesPosition) =>
    encode('krc1', { number: position.afterChangeSequence, uuid: position.discussionId }),
  decode(token: string): ChangesPosition | undefined {
    const fields = decode('krc1', token);
    return fields && { discussionId: fields.uuid, afterChangeSequence: fields.number };
  },
};
