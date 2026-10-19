import { z } from 'zod'
import { ContractVersion } from './version.ts'

// The numbered updates a caller follows while a run is being made. Each event carries its own
// contractVersion, because an event can be stored or passed on without its page (D-106).

/** How a finished run ended. `RunResult` in responses.ts has exactly these statuses. */
export const ResultStatus = z.enum(['completed', 'refused', 'stopped', 'failed', 'cancelled'])

const base = {
  contractVersion: ContractVersion,
  runId: z.string().min(1),
  /** Numbered from 1 per run and never renumbered. */
  seq: z.number().int().positive(),
  /** ISO 8601, UTC. */
  at: z.iso.datetime(),
}

export const RunEvent = z.union([
  z.strictObject({ ...base, type: z.literal('run.accepted') }),
  z.strictObject({
    ...base,
    type: z.enum(['stage.started', 'stage.finished']),
    stage: z.enum(['plan', 'stills', 'video']),
  }),
  z.strictObject({
    ...base,
    type: z.literal('verdict'),
    gate: z.string().min(1),
    outcome: z.enum(['accept', 'accept_with_label', 'fail']),
    shotId: z.string().min(1).optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('degraded'),
    shotId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.strictObject({ ...base, type: z.literal('run.finished'), status: ResultStatus }),
])

export type ResultStatus = z.infer<typeof ResultStatus>
export type RunEvent = z.infer<typeof RunEvent>
