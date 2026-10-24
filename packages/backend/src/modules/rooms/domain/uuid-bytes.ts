/** A UUID as its 16 bytes and back, for the compact stateless cursors. */
export const UUID_BYTES = 16;

export const uuidToBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll('-', ''), 'hex');

export function uuidFromBytes(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
