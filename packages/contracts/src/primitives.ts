import { z } from 'zod';

/** A UUID in any case; schemas that lower-case it say so where they use it. */
export const uuid = z.string().uuid();
/** A universe's privacy epoch: a non-negative int4. */
export const privacyEpoch = z.number().int().min(0).max(2147483647);
