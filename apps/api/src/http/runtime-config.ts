/**
 * How the API process runs (#201). Development mode is the Mac and every journey: the bootstrap
 * development identity, no trusted proxy. Server mode (NODE_ENV=production) is a world on the VPS
 * behind Caddy: no development identity at all, exactly one trusted loopback proxy hop, and the
 * world and commit /health reports. Mail, CSRF and web-origin requirements stay where they are
 * (mail/magic-link-sender.ts, http/web-session.ts); this module refuses only what it owns, and
 * names every problem at once.
 */

export type World = 'live' | 'stage' | 'dev';

const WORLDS: readonly World[] = ['live', 'stage', 'dev'];

type RuntimeConfig =
  | {
      mode: 'development';
      port: number;
      developmentToken: string;
      trustProxy: false;
    }
  | {
      mode: 'server';
      port: number;
      developmentToken: null;
      trustProxy: '127.0.0.1';
      world: World;
      commit: string;
    };

export class RuntimeConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid API configuration: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

function isWorld(value: string | undefined): value is World {
  return WORLDS.includes(value as World);
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const problems: string[] = [];

  let port = 4310;
  if (env.PORT !== undefined) {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      problems.push(
        `PORT must be a whole number from 1 to 65535; got ${JSON.stringify(env.PORT)}`,
      );
  }

  if (env.NODE_ENV !== 'production') {
    if (problems.length > 0) throw new RuntimeConfigError(problems);
    return {
      mode: 'development',
      port,
      developmentToken: env.KS_DEV_TOKEN ?? '',
      trustProxy: false,
    };
  }

  if (env.KS_DEV_TOKEN)
    problems.push(
      'KS_DEV_TOKEN must not be set in production: the development identity never runs on a server',
    );
  if (!isWorld(env.KS_WORLD))
    problems.push(
      `KS_WORLD must be one of ${WORLDS.join(', ')}; got ${JSON.stringify(env.KS_WORLD)}`,
    );
  const commit = env.KS_COMMIT ?? '';
  if (!/^[0-9a-f]{7,40}$/.test(commit))
    problems.push(
      `KS_COMMIT must be the deployed commit in hex; got ${JSON.stringify(env.KS_COMMIT)}`,
    );

  if (problems.length > 0 || !isWorld(env.KS_WORLD))
    throw new RuntimeConfigError(problems);
  return {
    mode: 'server',
    port,
    developmentToken: null,
    trustProxy: '127.0.0.1',
    world: env.KS_WORLD,
    commit,
  };
}
