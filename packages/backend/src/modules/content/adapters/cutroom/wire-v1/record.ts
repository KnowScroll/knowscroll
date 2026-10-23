import { z } from 'zod'
import { Degradation } from './responses.ts'
import { ContractVersion } from './version.ts'

// How a run was made: one entry per picture made, both candidates of a shot included (D-042),
// one entry per take made, every attempt's (S-093), each check with its outcome (I-4), and every
// degradation. A resumed run's record also lists every picture and take copied into it from the run
// it resumes, each with `keptFrom` naming that run (S-162); a failed run's pieces the resume did not
// keep stay in the failed run's own record. The takes and `keptFrom` amend version 1, as a
// criterion's type did (S-034): no caller exists for a bump to protect.

export const RunRecord = z.strictObject({
  contractVersion: ContractVersion,
  runId: z.string().min(1),
  pictures: z.array(
    z.strictObject({
      pictureId: z.string().min(1),
      shotId: z.string().min(1),
      chosen: z.boolean(),
      /** Present on a picture copied from the run this one resumes: that run (S-162). */
      keptFrom: z.string().min(1).optional(),
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
  /**
   * Every take made, every attempt's, in the order made — a take cut off inside its gates too — and,
   * in a resumed run, every take copied into it, first, in the order the run it resumes made them.
   */
  takes: z.array(
    z.strictObject({
      takeId: z.string().min(1),
      shotId: z.string().min(1),
      number: z.number().int().positive(),
      /** True exactly for the take each shot of a completed video run's video shows. */
      used: z.boolean(),
      /** Present on a take copied from the run this one resumes: that run (S-162). */
      keptFrom: z.string().min(1).optional(),
      /** Present for a take that reached those steps. */
      observationId: z.string().min(1).optional(),
      reconciliationId: z.string().min(1).optional(),
      checks: z.array(
        z.strictObject({
          gate: z.string().min(1),
          outcome: z.enum(['accept', 'accept_with_label', 'fail']),
        }),
      ),
    }),
  ),
  degradations: z.array(Degradation),
})

export type RunRecord = z.infer<typeof RunRecord>
