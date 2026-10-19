/** The longest address accepted: RFC 5321 limits a forward path to 256 octets including `<>`. */
export const MAX_ADDRESS_LENGTH = 254;

// One `@`, no whitespace, a dotted domain. Deliverability is the mail provider's question; this
// only keeps obviously malformed input out of the database and the outgoing request.
const addressShape = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/u;

/**
 * The stored form of an email address: Unicode NFC, trimmed and lower-cased, so one person's
 * address always finds the same account however it was typed. `undefined` when it is not an
 * address. Pure.
 */
export function normaliseAddress(input: string): string | undefined {
  const address = input.normalize('NFC').trim().toLowerCase().normalize('NFC');
  if (address.length < 3 || address.length > MAX_ADDRESS_LENGTH) return undefined;
  return addressShape.test(address) ? address : undefined;
}
