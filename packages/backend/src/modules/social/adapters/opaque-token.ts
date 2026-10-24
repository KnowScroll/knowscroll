import { randomInt } from 'node:crypto';

/**
 * A random positive integer below 2^48 for a fence that must carry no information: the value says
 * "this is not the same as before" and nothing about how many earlier ones there were. It fits the
 * contract's revision type (a safe integer) with room to spare.
 */
export const newOpaqueToken = (): number => randomInt(1, 2 ** 48);
