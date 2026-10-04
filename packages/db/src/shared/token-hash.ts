import { createHash } from 'node:crypto';

/** The stored form of a bearer, cookie or sign-in token: SHA-256 hex of its UTF-8 bytes (ADR-0009). */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
