import { createHash } from 'node:crypto';

/**
 * A UUID that depends only on `name`: a SHA-256 of it shaped as a version 4 UUID. Senders that must
 * reach one pg-boss job (`jobId`) derive its ID from what makes the work the same work. It names
 * work; it is not a secret and not a random identity.
 */
export function stableUuid(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
