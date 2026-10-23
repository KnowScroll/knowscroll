/**
 * Email addresses as sign-in accepts them: a strict subset of RFC 5321 (D-022, review m4). One
 * `@`; no display name, angle brackets, quotes, commas, semicolons, colons, brackets, backslashes
 * or whitespace; no control, format (zero-width) or other non-ASCII characters (internationalised
 * addresses are not accepted yet); a local part of at most 64 characters made of dot-separated
 * atoms; a domain of at most 253 characters made of at least two LDH labels (IDNA domains in their
 * `xn--` form); at most 254 characters in all. The stored and sent form is lower-case.
 */
export const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;

// RFC 5322 atext, the only characters a dot-atom local part may hold.
const localAtom = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
// One LDH label: letters, digits and inner hyphens.
const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Printable ASCII without the space: anything else (controls, NUL, NEL, zero-width, Unicode) is refused.
const printableAscii = /^[!-~]+$/;

/** The parts of an accepted address. */
export interface Address {
  readonly address: string;
  readonly local: string;
  readonly domain: string;
}

/**
 * The stored form of an email address (trimmed of surrounding spaces, lower-cased), or
 * `undefined` when it is not an address this product accepts. Pure.
 */
export function parseAddress(input: string): Address | undefined {
  const trimmed = input.trim();
  // ASCII first: lower-casing first would fold look-alikes (the Kelvin sign) into ASCII letters.
  if (!printableAscii.test(trimmed)) return undefined;
  const address = trimmed.toLowerCase();
  if (address.length < 3 || address.length > MAX_ADDRESS_LENGTH) return undefined;
  const parts = address.split('@');
  if (parts.length !== 2) return undefined;
  const [local = '', domain = ''] = parts;
  if (local.length === 0 || local.length > MAX_LOCAL_LENGTH) return undefined;
  if (!local.split('.').every((atom) => localAtom.test(atom))) return undefined;
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return undefined;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => domainLabel.test(label))) return undefined;
  // A top-level label is never all digits (that would be an IP address written as a name).
  if (/^[0-9]+$/.test(labels.at(-1) ?? '')) return undefined;
  return { address, local, domain };
}

/** The stored form of an address, or `undefined` (see {@link parseAddress}). Pure. */
export function normaliseAddress(input: string): string | undefined {
  return parseAddress(input)?.address;
}

/**
 * The address as the redeem page shows it before anyone is signed in: the first character of
 * the local part and the whole domain (`m•••@example.com`), enough for the owner to recognise it
 * and little for anyone else. Pure.
 */
export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '•••';
  return `${address.charAt(0)}•••${address.slice(at)}`;
}
