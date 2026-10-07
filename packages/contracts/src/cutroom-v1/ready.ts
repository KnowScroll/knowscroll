import { z } from 'zod'
import { ContractVersion } from './version.ts'

// The readiness route's response (docs/features/cutroom-sdk.md, Gate 2; S-173): one strict
// discriminated union on `ready`, so a 200 and a 503 carry the same two-key shape and only the
// literal `ready` value differs. No `Extra` keys accepted, no optional `ready`, no permissive
// object: a different version, an extra field, a missing field, or `ready` of the wrong literal
// must fail parsing, not silently coerce.

/** 200 — the engine is ready to accept work. */
export const ReadyTrue = z.strictObject({
  contractVersion: ContractVersion,
  ready: z.literal(true),
})

/** 503 — the engine has bound but the sole worker is not ready yet. */
export const ReadyFalse = z.strictObject({
  contractVersion: ContractVersion,
  ready: z.literal(false),
})

/** The route's two valid bodies, named once. A 500 body is `ErrorResponse`, not a `ReadyResponse`. */
export const ReadyResponse = z.union([ReadyTrue, ReadyFalse])

export type ReadyResponse = z.infer<typeof ReadyResponse>
export type ReadyTrue = z.infer<typeof ReadyTrue>
export type ReadyFalse = z.infer<typeof ReadyFalse>
