import { z } from 'zod'
import { ContractVersion } from './version.ts'

/** `400` is invalid, `404` is not-found, `500` is internal. */
export const ErrorResponse = z.strictObject({
  contractVersion: ContractVersion,
  error: z.enum(['not-found', 'invalid', 'internal']),
  detail: z.string(),
})

export type ErrorResponse = z.infer<typeof ErrorResponse>
