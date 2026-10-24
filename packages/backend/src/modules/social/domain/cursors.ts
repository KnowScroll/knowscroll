/**
 * Keyset positions for the three conversation reads. A cursor is a short base64url record of
 * where the last page ended. It carries nothing the caller does not already hold and grants
 * nothing: every read rechecks membership, and a position that does not fit the request is
 * refused as stale. No key is involved, so cursors survive restarts and work across API instances.
 */

const VERSION = 1;
const UUID_BYTES = 16;

export interface InboxPosition {
  /** Milliseconds since the epoch of the last conversation's activity time. */
  readonly activityMs: number;
  readonly conversationId: string;
}
export interface HistoryPosition {
  readonly conversationId: string;
  /** The oldest message sequence the caller already has; the page holds older ones. */
  readonly beforeSequence: number;
}
export interface ChangesPosition {
  readonly conversationId: string;
  /** The last change sequence the caller has seen; the page holds newer ones. */
  readonly afterChangeSequence: number;
}

const toBytes = (uuid: string) => Buffer.from(uuid.replaceAll('-', ''), 'hex');
function fromBytes(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encode(prefix: string, fields: { readonly number: number; readonly uuid: string }): string {
  const bytes = Buffer.alloc(1 + 8 + UUID_BYTES);
  bytes[0] = VERSION;
  bytes.writeBigUInt64BE(BigInt(fields.number), 1);
  toBytes(fields.uuid).copy(bytes, 9);
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
  return { number, uuid: fromBytes(bytes.subarray(9)) };
}

export const inboxCursor = {
  encode: (position: InboxPosition) => encode('kci1', { number: position.activityMs, uuid: position.conversationId }),
  decode(token: string): InboxPosition | undefined {
    const fields = decode('kci1', token);
    return fields && { activityMs: fields.number, conversationId: fields.uuid };
  },
};

export const historyCursor = {
  encode: (position: HistoryPosition) =>
    encode('kch1', { number: position.beforeSequence, uuid: position.conversationId }),
  decode(token: string): HistoryPosition | undefined {
    const fields = decode('kch1', token);
    return fields && { conversationId: fields.uuid, beforeSequence: fields.number };
  },
};

export const changesCursor = {
  encode: (position: ChangesPosition) =>
    encode('kcc1', { number: position.afterChangeSequence, uuid: position.conversationId }),
  decode(token: string): ChangesPosition | undefined {
    const fields = decode('kcc1', token);
    return fields && { conversationId: fields.uuid, afterChangeSequence: fields.number };
  },
};
