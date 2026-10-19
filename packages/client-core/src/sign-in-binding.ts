const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url (RFC 4648 §5) of some bytes: a verifier from 32 random bytes (43 characters). */
export function base64UrlOfBytes(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const remaining = bytes.length - index;
    out += alphabet.charAt((triple >> 18) & 63) + alphabet.charAt((triple >> 12) & 63);
    if (remaining > 1) out += alphabet.charAt((triple >> 6) & 63);
    if (remaining > 2) out += alphabet.charAt(triple & 63);
  }
  return out;
}

/** Standard padded base64 (what platform digests answer) as unpadded base64url: the S256 challenge. */
export function base64UrlOfBase64(base64: string): string {
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
