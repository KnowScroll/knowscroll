import type { ReelFinding } from '../../domain/reel/check.js';
import type { ReelFingerprints } from '../../domain/reel/fingerprint.js';
import { compileReelRequest } from '../../domain/reel/request.js';
import { approvalReference } from '../../domain/reel/script.js';
import { lintScript, type ScriptRefusal } from './assess.js';
import type { ReelPorts } from './ports.js';

export type CheckResult =
  | ({ readonly kind: 'refused' } & ScriptRefusal)
  | {
      readonly kind: 'ok';
      readonly script: string;
      readonly recipe: string;
      readonly findings: readonly ReelFinding[];
      readonly sentences: number;
      readonly longestSentenceWords: number;
      readonly fingerprints: ReelFingerprints;
      readonly approval: string;
      /** What an order would send first. A rehearsal and an order have different identities. */
      readonly rehearsal: { readonly scriptSha256: string; readonly requestId: string };
      readonly order: { readonly scriptSha256: string; readonly requestId: string };
    };

/**
 * The free, offline check an operator runs before any order: the product's own script checks, the
 * repetition rule against every v1 Reel, and the identities an order would carry. No database, no
 * network, no pool. An order repeats these checks and adds the ones that need this world.
 */
export function makeCheckScript(ports: Pick<ReelPorts, 'scripts' | 'sha256'>) {
  return (command: { readonly scriptName: string }): CheckResult => {
    const linted = lintScript(ports, command.scriptName);
    if (linted.kind === 'refused') return linted;
    const { script, fingerprints } = linted.linted;
    const identity = (until: 'plan' | 'video') => {
      const { scriptSha256, requestId } = compileReelRequest(script, { until, take: 1, ceilingCents: 1 }, ports.sha256);
      return { scriptSha256, requestId };
    };
    return {
      kind: 'ok',
      script: command.scriptName,
      recipe: script.recipe,
      findings: [],
      sentences: script.brief.narration.length,
      longestSentenceWords: Math.max(
        ...script.brief.narration.map((sentence) => sentence.text.trim().split(/\s+/).length),
      ),
      fingerprints,
      approval: approvalReference(script),
      rehearsal: identity('plan'),
      order: identity('video'),
    };
  };
}
