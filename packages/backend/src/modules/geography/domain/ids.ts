/** A keyed hash of `message` under `secret`, as lowercase hex: HMAC-SHA-256, supplied by an adapter. */
export type Mac = (secret: string, message: string) => string;

/** A UUID shape (version 5, variant `a`) made of a hex digest, as `dustCueId` formats its ids. */
function uuidOf(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The id a new place gets (D-416): an HMAC of the universe's place secret and the place's semantic key, so one run, the
 * next run and the apply that re-reads the same facts all derive the same id with no table of allocated slots, and an id
 * names nothing and reveals nothing without the secret. A stored place keeps the id it was stored with.
 */
export function derivedPlaceId(mac: Mac, secret: string, key: string): string {
  return uuidOf(mac(secret, `place|${key}`));
}

/**
 * The id a new route gets: an HMAC of the secret and the sorted pair of the two planets' semantic keys, the pair that is
 * also the route's stored key, so the same two planets always derive the same route whichever end names it first.
 */
export function derivedRouteId(mac: Mac, secret: string, keyA: string, keyB: string): string {
  return uuidOf(mac(secret, `route|${[keyA, keyB].sort().join('|')}`));
}

/** The semantic key of the route between two planets: the sorted pair, as it is stored. */
export const routeKey = (keyA: string, keyB: string) => [keyA, keyB].sort().join('|');
