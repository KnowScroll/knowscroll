import type { CanaryAddressShape } from '../../domain/canary/personas.js';
import type { CanaryPorts } from './ports.js';
import { deleteThroughAccountFlow } from './run-canary.js';

/** The most disposable addresses one cleanup looks at; more than any run could leave. */
const LIST_LIMIT = 500;
/** How long one account's deletion may take before it is reported unfinished. */
const DELETION_WAIT_MS = 180_000;

export interface CleanupReport {
  /** Accounts that are exactly the canary's own (and, with `run`, that run's). */
  readonly found: number;
  /** The runs those accounts belong to. */
  readonly runs: number;
  readonly deleted: number;
  /** Accounts whose deletion did not finish, whose sign-in was refused, or that were not started because of a stop. */
  readonly failed: number;
  /** The cleanup was stopped before it reached every account. */
  readonly stopped: boolean;
}

/**
 * Finds the canary's own disposable accounts in this world and deletes them through the real account flow, for a run
 * that was killed or that kept its accounts. An address qualifies only if it is exactly the shape the canary makes
 * (`<prefix>canary-<8 hex>-<persona><suffix>@<domain>`, optionally for one run) and belongs to a disposable account;
 * the operator sign-in mint refuses anything outside the operator pattern, so no other address is ever opened.
 *
 * Each account is minted a fresh link (an audit row each), signed in through the HTTP route and deleted. With
 * `dryRun` it only counts. Stops starting new accounts once `signal` is aborted; the one in hand finishes within its bound.
 */
export async function cleanupCanary(
  ports: CanaryPorts,
  shape: CanaryAddressShape,
  options: { readonly run?: string; readonly dryRun: boolean },
  signal?: AbortSignal,
): Promise<CleanupReport> {
  const listed = await ports.accounts.listCanaryAddresses({
    localPrefix: shape.localPrefix,
    domain: shape.domain,
    limit: LIST_LIMIT,
  });
  const mine = listed.filter((address) => {
    const run = shape.runOf(address);
    return run !== undefined && (options.run === undefined || run === options.run);
  });
  const runs = new Set(mine.map((address) => shape.runOf(address))).size;
  if (options.dryRun) return { found: mine.length, runs, deleted: 0, failed: 0, stopped: false };
  let deleted = 0;
  let failed = 0;
  let stopped = false;
  for (const address of mine) {
    if (signal?.aborted === true) {
      stopped = true;
      failed += 1;
      continue;
    }
    const minted = await ports.accounts.mint(address);
    if (minted.kind === 'refused') {
      failed += 1;
      continue;
    }
    try {
      const api = await ports.accounts.signIn(minted.link);
      if (await deleteThroughAccountFlow(ports, api, DELETION_WAIT_MS)) deleted += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { found: mine.length, runs, deleted, failed, stopped };
}
