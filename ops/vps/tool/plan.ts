/**
 * The server tool's decisions (#201), kept free of side effects so they can be tested anywhere.
 * ops/vps/tool/system.ts acts on them. Erasable TypeScript only: the server runs this file with
 * Node's own type stripping, no build step.
 */

export type World = 'live' | 'stage' | 'dev';

const WORLDS: readonly World[] = ['live', 'stage', 'dev'];

/** The branch each world follows; dev also takes any commit the agent chooses to try. */
export const BRANCH_OF: Readonly<Record<World, string>> = {
  dev: 'dev',
  stage: 'stage',
  live: 'main',
};

export type DeployRequest =
  | { ok: true; world: World; commit: string }
  | { ok: false; reason: string };

export function validateDeployRequest(
  world: string,
  commit: string,
  branch: { tip: string | null },
): DeployRequest {
  if (!WORLDS.includes(world as World))
    return { ok: false, reason: `unknown world ${JSON.stringify(world)}` };
  if (!/^[0-9a-f]{40}$/.test(commit))
    return {
      ok: false,
      reason: 'the commit must be 40 lowercase hex characters',
    };
  const w = world as World;
  if (w !== 'dev' && branch.tip !== commit)
    return {
      ok: false,
      reason: `${w} deploys only the tip of ${BRANCH_OF[w]} (${branch.tip ?? 'unknown'}), not ${commit}`,
    };
  return { ok: true, world: w, commit };
}

export type Release = { commit: string; mtimeMs: number };

/**
 * Releases cleanup may delete: never one any world uses now or used last (`inUse`); of the
 * rest, keep the `keepNewest` most recent and select the others, oldest first.
 */
export function releasesToDelete(
  releases: readonly Release[],
  inUse: ReadonlySet<string>,
  keepNewest: number,
): string[] {
  const unused = releases
    .filter((r) => !inUse.has(r.commit))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unused
    .slice(keepNewest)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((r) => r.commit);
}

export type DiskGuardDecision =
  | 'fine'
  | 'warn'
  | 'critical'
  | 'still-critical'
  | 'recovered';

/** 80 % warns; 90 % is critical (deploys refused, optional services paused, emergency cleanup);
 * once critical, the flag clears only below 85 %, so the guard cannot flap around one number. */
export function diskGuardDecision(
  usedPercent: number,
  flagPresent: boolean,
): DiskGuardDecision {
  if (flagPresent) return usedPercent < 85 ? 'recovered' : 'still-critical';
  if (usedPercent >= 90) return 'critical';
  if (usedPercent >= 80) return 'warn';
  return 'fine';
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1] as string] = match[2] as string;
  }
  return env;
}
