import { oc } from '@orpc/contract';
import { z } from 'zod';
import { UuidSchema } from './ids.js';
import { ShareableContentProjectionSchema } from './conversations.js';
import { ResolveContentShareSchema } from './content-shares.js';
import { publicContentShareErrors, publicContentShareProblemResponses, socialJsonData } from './social-problems.js';

/** Separate public JSON input, reusing the existing exact sensitive token shape. Cookies and
 * credentials cannot widen this projection. A conversation token is uniformly unavailable.
 * Token possession/preview/prefetch never joins, creates an encounter, or grants media access. */
export const ReadPublicContentSharePreviewSchema = socialJsonData(ResolveContentShareSchema);
export const PublicContentSharePreviewSchema = socialJsonData(
  z.discriminatedUnion('status', [
    z.strictObject({ version: z.literal('content-share.v1'), readId: UuidSchema, status: z.literal('unavailable') }),
    z.strictObject({
      version: z.literal('content-share.v1'),
      readId: UuidSchema,
      status: z.literal('public_metadata'),
      content: ShareableContentProjectionSchema,
    }),
  ]),
);

/** Declarations only, outside private /v1. This JSON endpoint carries tokens in its body, never
 * an ordinary API URL. The separately reviewed GET /s/:token HTML landing is the dedicated URL
 * exception and must isolate proxy/history/referrer/OG/log handling. No wildcard auth opt-out. */
export const publicContentSharesContract = {
  preview: oc
    .route({
      method: 'POST',
      path: '/s/preview',
      successStatus: 200,
      tags: ['public-content-share'],
      spec: publicContentShareProblemResponses,
    })
    .errors(publicContentShareErrors)
    .input(ReadPublicContentSharePreviewSchema)
    .output(PublicContentSharePreviewSchema),
};
export type ReadPublicContentSharePreview = z.infer<typeof ReadPublicContentSharePreviewSchema>;
export type PublicContentSharePreview = z.infer<typeof PublicContentSharePreviewSchema>;

/** Pure request correlation and public-only projection. It cannot select an audience from
 * cookies, authorise the token, or turn an unavailable result into permission to retry a write. */
export function publicContentSharePreviewForRead(
  request: unknown,
  reply: unknown,
): PublicContentSharePreview | undefined {
  const input = ReadPublicContentSharePreviewSchema.safeParse(request);
  const output = PublicContentSharePreviewSchema.safeParse(reply);
  if (!input.success || !output.success || input.data.readId.toLowerCase() !== output.data.readId.toLowerCase())
    return undefined;
  return output.data;
}
