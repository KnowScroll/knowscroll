import { ExpireFormationJobSchema, RecoverFormationJobSchema } from '../events.js';
import type { FormationPorts, FormationRecoveryCandidate } from './ports.js';
/** Exact maintenance only. The root/epoch/account/Clear fence runs before reading the row. */
export function formationMaintenance(p: FormationPorts) {
  const finish = async (job: FormationRecoveryCandidate, recovery: boolean): Promise<boolean> => {
    const result = await (recovery ? p.withRecoveryScope : p.withScope)(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'scenes.expire-formation' },
      },
      async (scope) => {
        if (!(await p.ownerActive(scope))) return false;
        const row = await p.store.read(scope, { kind: 'transition', transitionId: job.transitionId });
        if (
          !row?.claim ||
          row.claim.claimId !== job.claimId ||
          row.terminal ||
          p.now().getTime() < Date.parse(row.claim.expiresAt)
        )
          return false;
        const changed = await p.store.terminal(scope, job.transitionId, job.claimId, 'skipped', row.claim.expiresAt);
        if (changed) await p.notify(scope, await p.advance(scope));
        return changed;
      },
    );
    return result.kind === 'entered' && result.value;
  };
  return {
    expire: async (input: unknown) => {
      await finish(ExpireFormationJobSchema.parse(input), false);
    },
    recover: async (input: unknown) => {
      const q = RecoverFormationJobSchema.parse(input);
      // Adapter commits its required advancing child before ANY owner work, including busy heads.
      const page = await p.readRecoveryPage(q);
      const deadline = performance.now() + 30_000;
      let completed = 0,
        skipped = 0;
      for (const job of page) {
        if (performance.now() >= deadline) {
          skipped += page.length - completed - skipped;
          break;
        }
        try {
          if (await finish(job, true)) completed++;
          else skipped++;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (code === 'SCOPE_BUSY' || code === '55P03' || code === '57014') skipped++;
          else throw error;
        }
      }
      return { completed, skipped };
    },
  };
}
