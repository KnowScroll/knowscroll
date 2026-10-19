import { z } from 'zod';
import {
  CommitSchema,
  NodeEnvSchema,
  Sha256Schema,
  WorldSchema,
  parseEnvironment,
  type Environment,
  type NodeEnv,
} from './environment.js';

/**
 * Release identity shared by every process: which world it serves, which commit it was built
 * from and which release artifact it came from. Production refuses placeholders so a deployed
 * process can always be traced to its release; development and test default to `unknown`.
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
  KS_WORLD: WorldSchema.default('local'),
  KS_COMMIT: CommitSchema.or(z.literal('unknown')).default('unknown'),
  KS_ARTIFACT_SHA256: Sha256Schema.or(z.literal('unknown')).default('unknown'),
});

/** Reads `NODE_ENV`, `KS_WORLD`, `KS_COMMIT` and `KS_ARTIFACT_SHA256`. Throws `ConfigurationError`. */
export function readReleaseIdentity(env: Environment): ReleaseIdentity {
  const variables = {
    NODE_ENV: env['NODE_ENV'],
    KS_WORLD: env['KS_WORLD'],
    KS_COMMIT: env['KS_COMMIT'],
    KS_ARTIFACT_SHA256: env['KS_ARTIFACT_SHA256'],
  };
  const nodeEnv = parseEnvironment(z.object({ NODE_ENV: NodeEnvSchema.default('development') }), variables).NODE_ENV;
  const parsed =
    nodeEnv === 'production'
      ? parseEnvironment(productionSchema, variables)
      : parseEnvironment(nonProductionSchema, variables);
  return { nodeEnv, world: parsed.KS_WORLD, commit: parsed.KS_COMMIT, artifactSha256: parsed.KS_ARTIFACT_SHA256 };
}

/** The world name for diagnostics before full validation: the validated `KS_WORLD` or `unknown`. */
export function worldForDiagnostics(env: Environment): string {
  const result = WorldSchema.safeParse(env['KS_WORLD']);
  return result.success ? result.data : 'unknown';
}
