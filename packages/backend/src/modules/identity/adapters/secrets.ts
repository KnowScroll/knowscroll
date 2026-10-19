import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { IdentitySecrets, Secret } from '../application/ports.js';

/** SHA-256 (hex) of a presented token: the only form a token is ever stored or looked up in. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes as 43 base64url characters, behind a recognisable prefix (scanners, canaries). */
function newSecret(prefix: 'ksl_' | 'kss_'): Secret {
  const token = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

/** Crypto-backed secrets and IDs for the identity use cases. */
export const cryptoSecrets: IdentitySecrets = {
  newLinkSecret: () => newSecret('ksl_'),
  newSessionSecret: () => newSecret('kss_'),
  hashToken,
  newId: () => uuidv7(),
};
