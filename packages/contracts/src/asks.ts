import { z } from 'zod';
import { privacyEpoch, uuid } from './primitives.ts';

// Literal source facts only; no job or paid-task authorization.
const askUuid = uuid.transform((value) => value.toLowerCase());
export const explicitAskInput = z
  .object({
    clientAskId: askUuid,
    exposureId: askUuid,
    expectedPrivacyEpoch: privacyEpoch,
    question: z
      .string()
      .refine(
        (value) =>
          value.trim().length > 0 &&
          !value.includes('\0') &&
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            value,
          ) &&
          new TextEncoder().encode(value).byteLength <= 4096,
      ),
  })
  .strict();
export type ExplicitAskInput = z.infer<typeof explicitAskInput>;
export type ExplicitAskReceipt = {
  askId: string;
  eventId: string;
  status: 'recorded_only';
};
