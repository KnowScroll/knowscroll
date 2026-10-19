import { z } from 'zod';
import {
  CommitSchema,
  NodeEnvSchema,
  Sha256Schema,
  WorldSchema,
  checkEnvironment,
  combineChecks,
  type Checked,
  type Environment,
  type NodeEnv,
} from './environment.js';

/**
 * Release identity shared by every process: which world it serves, which commit it was built
 * from and which release artifact it came from. `KS_WORLD` is required in every `NODE_ENV` (a
 * missing world never silently becomes `local`, which would allow test-only adapters). Production
 * refuses placeholders so a deployed process can always be traced to its release; development
 * and test default the commit and artifact to `unknown`.
 */
export interface ReleaseIdentity {
  readonly nodeEnv: NodeEnv;
  readonly world: string;
  readonly commit: string;
  readonly artifactSha256: string;
}

const productionSchema = z.object({
  NODE_ENV: z.literal('production'),
  KS_WORLD: WorldSchema,
  KS_COMMIT: CommitSchema,
  KS_ARTIFACT_SHA256: Sha256Schema,
});

const nonProductionSchema = z.object({
  NODE_ENV: z.enum(['test', 'development']).default('development'),
  KS_WORLD: WorldSchema,
  KS_COMMIT: CommitSchema.or(z.literal('unknown')).default('unknown'),
  KS_ARTIFACT_SHA256: Sha256Schema.or(z.literal('unknown')).default('unknown'),
});

/**
 * Checks `NODE_ENV`, `KS_WORLD`, `KS_COMMIT` and `KS_ARTIFACT_SHA256`, returning every problem
 * (so a process can report them together with its own variables' problems).
 */
export function checkReleaseIdentity(env: Environment): Checked<ReleaseIdentity> {
  const variables = {
    NODE_ENV: env['NODE_ENV'],
    KS_WORLD: env['KS_WORLD'],
    KS_COMMIT: env['KS_COMMIT'],
    KS_ARTIFACT_SHA256: env['KS_ARTIFACT_SHA256'],
  };
  const nodeEnv = checkEnvironment(z.object({ NODE_ENV: NodeEnvSchema.default('development') }), variables);
  if (!nodeEnv.ok) return nodeEnv;
  const parsed =
    nodeEnv.value.NODE_ENV === 'production'
      ? checkEnvironment(productionSchema, variables)
      : checkEnvironment(nonProductionSchema, variables);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      nodeEnv: nodeEnv.value.NODE_ENV,
      world: parsed.value.KS_WORLD,
      commit: parsed.value.KS_COMMIT,
      artifactSha256: parsed.value.KS_ARTIFACT_SHA256,
    },
  };
}

/** Reads the release identity. Throws one `ConfigurationError` listing every problem. */
export function readReleaseIdentity(env: Environment): ReleaseIdentity {
  return combineChecks(checkReleaseIdentity(env))[0];
}

/** The world name for diagnostics before full validation: the validated `KS_WORLD` or `unknown`. */
export function worldForDiagnostics(env: Environment): string {
  const result = WorldSchema.safeParse(env['KS_WORLD']);
  return result.success ? result.data : 'unknown';
}

/** The commit for diagnostics before full validation: the validated `KS_COMMIT` or `unknown`. */
export function commitForDiagnostics(env: Environment): string {
  const result = CommitSchema.safeParse(env['KS_COMMIT']);
  return result.success ? result.data : 'unknown';
}
