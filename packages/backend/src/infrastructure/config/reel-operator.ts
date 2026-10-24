import { readMediaImportConfig } from './processes.js';
import { ConfigurationError, type Environment } from './environment.js';

/** The pool's own database; the same server as the world's, another database (ADR-0050). */
const POOL_DATABASE = 'knowscroll_pool';

export interface ReelOperatorConfig extends ReturnType<typeof readMediaImportConfig> {
  /** Connection URL of the shared Reel pool. A credential: never log it. */
  readonly poolUrl: string;
}

/**
 * The Reel operator commands' settings (`dist/operator.js reel ...`): everything the media import
 * needs (world, database, media root, Cutroom origin and artifact root, ffprobe) plus the shared
 * pool. The pool URL is `KS_POOL_DATABASE_URL`, or the world's own `DATABASE_URL` pointing at
 * `knowscroll_pool`, so a world's role and password reach the pool without another secret.
 * Refused outside the operator worlds. Throws one `ConfigurationError` naming variables, never values.
 */
export function readReelOperatorConfig(env: Environment): ReelOperatorConfig {
  const media = readMediaImportConfig(env);
  const explicit = env['KS_POOL_DATABASE_URL'];
  if (explicit !== undefined && !/^postgres(ql)?:\/\//.test(explicit))
    throw new ConfigurationError(['KS_POOL_DATABASE_URL: must_be_a_postgres_url']);
  const derived = new URL(media.database.url);
  derived.pathname = `/${POOL_DATABASE}`;
  return { ...media, poolUrl: explicit ?? derived.toString() };
}
