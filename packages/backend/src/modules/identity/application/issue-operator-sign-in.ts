import { z } from 'zod';
import type { IssueOperatorSignIn, IssueOperatorSignInResult, RootResolution, ScopeRefusal } from '../public.js';
import { normaliseAddress } from '../domain/addresses.js';
import type { IssueOperatorSignInPorts } from './ports.js';

export const ISSUE_OPERATOR_SIGN_IN_OPERATION = 'identity.issue-operator-sign-in';
export const OPERATOR_OUTCOME_VERSION = 1;

/** The stored outcome of one operator issue: which disposable account received a link. */
export const OperatorOutcomeSchema = z.object({
  accountId: z.uuid(),
  universeId: z.uuid(),
  accountCreated: z.boolean(),
});

export type OperatorOutcome = z.infer<typeof OperatorOutcomeSchema>;

/**
 * `issueOperatorSignIn`: on dev/stage only, mint a one-time sign-in link for a disposable test
 * account from a server shell (D-007; `dist/operator.js issue-sign-in`). Whether it may run at all
 * (never in live, only with `KS_ALLOW_OPERATOR_SIGN_IN=1`) is decided by the caller before this
 * is built.
 *
 * Steps (one transaction; lock order address → personal root): address lock → find the account;
 * an account that is not disposable → `not_disposable` (nothing written); none → create the
 * account (disposable), its address and its universe root → lock and recheck the root → a receipt
 * for this issue (a fresh command ID: the durable record that an operator issued a link) → an
 * operator link (15 minutes, single use) → commit. The link is returned to print; it is never
 * logged or stored (only its hash is).
 */
export function makeIssueOperatorSignIn(ports: IssueOperatorSignInPorts): IssueOperatorSignIn {
  return async function issueOperatorSignIn(input: { readonly email: string }): Promise<IssueOperatorSignInResult> {
    const address = normaliseAddress(input.email);
    if (address === undefined) return { kind: 'refused', reason: 'invalid_address' };
    const secret = ports.secrets.newLinkSecret();
    const commandId = ports.secrets.newId();

    const outcome = await ports.withResolvedPersonalScope(
      async (tx): Promise<RootResolution<{ readonly accountCreated: boolean }, 'not_disposable'>> => {
        await ports.lockAddress(tx, address);
        const existing = await ports.findAccountByAddress(tx, address);
        if (existing !== undefined && !existing.disposable) return { kind: 'stop', result: 'not_disposable' };
        const account = existing ?? {
          accountId: ports.secrets.newId(),
          universeId: ports.secrets.newId(),
          privacyEpoch: 1,
          disposable: true,
        };
        if (existing === undefined) await ports.createAccount(tx, { ...account, address });
        return {
          kind: 'enter',
          authority: {
            universeId: account.universeId,
            privacyEpoch: account.privacyEpoch,
            actor: { kind: 'account', accountId: account.accountId },
          },
          context: { accountCreated: existing === undefined },
        };
      },
      async (scope, context): Promise<OperatorOutcome> => {
        const key = {
          commandId,
          operation: ISSUE_OPERATOR_SIGN_IN_OPERATION,
          requestHash: ports.hashRequest(ISSUE_OPERATOR_SIGN_IN_OPERATION, { tokenHash: secret.hash }),
          outcomeVersion: OPERATOR_OUTCOME_VERSION,
        };
        await ports.insertReceipt(scope, key);
        await ports.createOperatorLink(scope, { tokenHash: secret.hash, address });
        const actor = scope.authority.actor;
        const stored: OperatorOutcome = {
          accountId: actor.kind === 'account' ? actor.accountId : '',
          universeId: scope.authority.universeId,
          accountCreated: context.accountCreated,
        };
        await ports.completeReceipt(scope, commandId, stored);
        return OperatorOutcomeSchema.parse(stored);
      },
    );
    switch (outcome.kind) {
      case 'entered':
        return { kind: 'issued', outcome: outcome.value, link: ports.linkFor(secret.token) };
      case 'stopped':
        return { kind: 'refused', reason: outcome.result };
      case 'refused':
        return { kind: 'refused', reason: refusalOf(outcome.refusal) };
    }
  };
}

function refusalOf(refusal: ScopeRefusal): 'account_unavailable' {
  switch (refusal.kind) {
    case 'universe_missing':
    case 'universe_suspended':
    case 'account_mismatch':
    case 'epoch_changed':
      return 'account_unavailable';
  }
}
