/** Fixed 32-bit integer mixing, never ambient randomness, clocks, locale or platform APIs. */
export function seedState(seed: string): number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  return state;
}
export function variation(state: number, channel: number): number {
  let n = (state + Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 0x1_0000_0000;
}

/**
 * One pinned number in [0, 1) for a seed and a channel. Every generator input that must come out
 * the same on the server, the web and Hermes goes through this and nothing else. Channels 0 and 1
 * belong to `silhouette.v1`; look rules use 16 and above.
 */
export function seededUnit(seed: string, channel: number): number {
  return variation(seedState(seed), channel);
}
