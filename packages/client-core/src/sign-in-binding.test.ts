import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CODE_CHALLENGE_PATTERN, CODE_VERIFIER_PATTERN } from '@knowscroll/contracts';
import { base64UrlOfBase64, base64UrlOfBytes } from './sign-in-binding';

describe('the native sign-in binding encodings (RFC 7636 S256, review m10)', () => {
  // RFC 7636 Appendix B.
  const octets = new Uint8Array([
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
    88, 5, 88, 83, 132, 141, 121,
  ]);

  it('encodes the verifier and its challenge as the RFC example does', () => {
    const verifier = base64UrlOfBytes(octets);
    expect(verifier).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    const challenge = base64UrlOfBase64(createHash('sha256').update(verifier, 'ascii').digest('base64'));
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(CODE_VERIFIER_PATTERN.test(verifier)).toBe(true);
    expect(CODE_CHALLENGE_PATTERN.test(challenge)).toBe(true);
  });

  it('matches Node for every length, without padding', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(Array.from({ length }, (_, index) => (index * 37 + length) % 256));
      expect(base64UrlOfBytes(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});
