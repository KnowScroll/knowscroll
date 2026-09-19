import { z } from 'zod'
import { Degradation } from './responses.ts'
import { ContractVersion } from './version.ts'

// How a run was made: one entry per picture made, both candidates of a shot included (D-042),
// each check with its outcome (I-4), and every degradation.

export const RunRecord = z.strictObject({
  contractVersion: ContractVersion,
  runId: z.string().min(1),
  pictures: z.array(
    z.strictObject({
      pictureId: z.string().min(1),
      shotId: z.string().min(1),
      chosen: z.boolean(),
      /** Present for a picture that reached those steps. */
      observationId: z.string().min(1).optional(),
      reconciliationId: z.string().min(1).optional(),
      checks: z.array(
        z.strictObject({
          gate: z.string().min(1),
          step: z.string().min(1).optional(),
          outcome: z.enum(['accept', 'accept_with_label', 'fail']),
        }),
      ),
    }),
  ),
  degradations: z.array(Degradation),
})

export type RunRecord = z.infer<typeof RunRecord>
