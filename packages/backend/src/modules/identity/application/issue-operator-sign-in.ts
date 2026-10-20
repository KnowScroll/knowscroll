import { z } from 'zod';
import type {
  IssueOperatorSignIn,
  IssueOperatorSignInResult,
  RootResolution,
  ScopeRefusal,
  ScopeWork,
} from '../public.js';
import { parseAddress } from '../domain/addresses.js';
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
 * (an allow-listed world, `KS_ALLOW_OPERATOR_SIGN_IN=1`, a disposable-address pattern) is checked
 * by the caller before this is built; the address is checked against the pattern here.
 *
 * Steps (one transaction; lock order address → personal root): the address must match the
 * world's operator pattern (`address_not_allowed` otherwise; review m2) → address lock → find the
 * account (one that proved its address by mail → `not_disposable`), or create it (disposable),
 * its address and its universe root → lock and recheck the
 * root → a receipt for this issue (a fresh command ID) → an operator link (15 minutes, single use)
 * → the durable audit row in `ops.operator_sign_ins` (world, time, operator source, account;
 * survives "clear history", tombstoned by account deletion; review m9) → commit. The link is
 * returned to print; it is never logged or stored (only its hash is).
 */
export function makeIssueOperatorSignIn(ports: IssueOperatorSignInPorts): IssueOperatorSignIn {
  return async function issueOperatorSignIn(input): Promise<IssueOperatorSignInResult> {
    const address = parseAddress(input.email);
    if (address === undefined) return { kind: 'refused', reason: 'invalid_address' };
    if (!ports.operatorAddressAllowed(address.address)) return { kind: 'refused', reason: 'address_not_allowed' };
    const secret = ports.secrets.newLinkSecret();
    const commandId = ports.secrets.newId();

    const outcome = await ports.withResolvedPersonalScope(
      async (tx): Promise<RootResolution<{ readonly accountCreated: boolean }, 'not_disposable'>> => {
        await ports.lockAddress(tx, address.address);
        const existing = await ports.findAccountByAddress(tx, address.address);
        // An account whose address proved itself by mail is never opened by an operator link.
        if (existing !== undefined && !existing.disposable) return { kind: 'stop', result: 'not_disposable' };
        const account = existing ?? {
          accountId: ports.secrets.newId(),
          universeId: ports.secrets.newId(),
          privacyEpoch: 1,
          disposable: true,
        };
        if (existing === undefined) await ports.createAccount(tx, { ...account, address: address.address });
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
      async (scope, context): Promise<ScopeWork<OperatorOutcome, never>> => {
        const key = {
          commandId,
          operation: ISSUE_OPERATOR_SIGN_IN_OPERATION,
          requestHash: ports.hashRequest(ISSUE_OPERATOR_SIGN_IN_OPERATION, { tokenHash: secret.hash }),
          outcomeVersion: OPERATOR_OUTCOME_VERSION,
        };
        await ports.insertReceipt(scope, key);
        await ports.createOperatorLink(scope, {
          tokenHash: secret.hash,
          address: address.address,
          domain: address.domain,
        });
        const actor = scope.authority.actor;
        const stored = OperatorOutcomeSchema.parse({
          accountId: actor.kind === 'account' ? actor.accountId : undefined,
          universeId: scope.authority.universeId,
          accountCreated: context.accountCreated,
        });
        await ports.recordOperatorIssue(scope, {
          id: ports.secrets.newId(),
          accountId: stored.accountId,
          accountCreated: stored.accountCreated,
        });
        await ports.completeReceipt(scope, commandId, stored);
        return { kind: 'commit', value: stored };
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
