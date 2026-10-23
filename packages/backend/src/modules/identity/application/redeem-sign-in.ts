import { z } from 'zod';
import type {
  RedeemRefusal,
  RedeemSignIn,
  RedeemSignInCommand,
  RedeemSignInResult,
  RootResolution,
  ScopeRefusal,
  ScopeWork,
} from '../public.js';
import type { AccountRoot, LinkRecord, RedeemSignInPorts } from './ports.js';

export const REDEEM_SIGN_IN_OPERATION = 'identity.redeem-sign-in';
/** Version of the stored outcome below. A new shape gets a new version (blueprint §5). */
export const REDEEM_OUTCOME_VERSION = 1;

/** The stored outcome of a redemption. A replay returns it with a replacement session. */
export const RedeemOutcomeSchema = z.object({
  accountId: z.uuid(),
  universeId: z.uuid(),
  /** True for the redemption that created the account and its universe root. */
  accountCreated: z.boolean(),
});

export type RedeemOutcome = z.infer<typeof RedeemOutcomeSchema>;

interface ResolvedLink {
  readonly origin: 'email' | 'operator';
  readonly accountCreated: boolean;
  /** The link's address: shown back to the person it belongs to, never stored in the receipt. */
  readonly address: string;
}

/**
 * Whether this client may redeem this link (review m10): a link requested by a native app is
 * bound to the verifier in that app's secure store (PKCE-style S256) and is redeemed only with
 * it; a native redemption needs such a binding; the web redeems unbound links only, after the
 * person confirmed the masked address (review m8).
 */
function boundToThisClient(
  link: LinkRecord,
  command: RedeemSignInCommand,
  challengeOf: (verifier: string) => string,
): boolean {
  if (command.client === 'native')
    return (
      link.codeChallenge !== undefined &&
      command.codeVerifier !== undefined &&
      challengeOf(command.codeVerifier) === link.codeChallenge
    );
  return link.codeChallenge === undefined;
}

/**
 * `redeemSignIn`: exchange a sign-in link for a session (POST /auth/redeem). A link is consumed by
 * this POST only, so a mail scanner that fetches the link page signs nobody in.
 *
 * Authority: possession of an unexpired, unconsumed link (and, for native, its verifier). The
 *   account is the link's address.
 * Steps (one transaction; identity's lock order address → link → personal root):
 *   1. address lock, then the link's row lock; unknown, expired, consumed by another command, not
 *      bound to this client (PKCE), or an operator link this world refuses (flag, world or
 *      pattern) → `link_invalid`;
 *   2. consumed by this same command → the retry of a redemption whose answer was lost: enter
 *      that account's scope to replay;
 *   3. otherwise find the account by address, or create the account, its address and its
 *      universe root (privacy epoch 1); a mailed link redeemed into a disposable account makes it
 *      a real one (no more operator links for it; review m2); then consume the link;
 *   4. lock the universe root and recheck it (suspended → `account_unavailable`);
 *   5. receipt `(universe, commandId)`: another request under this ID → `command_key_reused`; an
 *      identical replay needs one of this command's sessions still live (review m5) and replaces
 *      it; else insert the receipt;
 *   6. issue a session (web cookie or native bearer, 30 days), store the outcome, commit.
 *   Every refusal rolls everything back (review m1): a refused redemption consumes nothing.
 * Side effects: the link's consumption, at most one new account + address + universe, one receipt
 *   and one live session per redemption command. All or nothing.
 * Concurrency: retries of one command, or two links for one new address, serialise on the address
 *   lock, so there is never a second account or universe for an address (also enforced by unique
 *   keys on the address and on the universe's account).
 */
export function makeRedeemSignIn(ports: RedeemSignInPorts): RedeemSignIn {
  return async function redeemSignIn(command: RedeemSignInCommand): Promise<RedeemSignInResult> {
    const tokenHash = ports.secrets.hashToken(command.token);
    const key = {
      commandId: command.commandId,
      operation: REDEEM_SIGN_IN_OPERATION,
      requestHash: ports.hashRequest(REDEEM_SIGN_IN_OPERATION, { tokenHash, client: command.client }),
      outcomeVersion: REDEEM_OUTCOME_VERSION,
    };

    const resolve = async (
      tx: Parameters<typeof ports.lockLink>[0],
    ): Promise<RootResolution<ResolvedLink, RedeemRefusal>> => {
      const link = await ports.lockLink(tx, tokenHash);
      if (link === undefined || link.expired) return { kind: 'stop', result: 'link_invalid' };
      if (link.origin === 'operator' && !ports.operatorAddressAllowed(link.address))
        return { kind: 'stop', result: 'link_invalid' };
      if (!boundToThisClient(link, command, (verifier) => ports.secrets.challengeOf(verifier)))
        return { kind: 'stop', result: 'link_invalid' };
      if (link.consumed !== undefined) {
        if (link.consumed.commandId !== command.commandId) return { kind: 'stop', result: 'link_invalid' };
        const account = await ports.findAccountById(tx, link.consumed.accountId);
        if (account === undefined) return { kind: 'stop', result: 'account_unavailable' };
        return enter(account, { origin: link.origin, accountCreated: false, address: link.address });
      }
      let account = await ports.findAccountByAddress(tx, link.address);
      let accountCreated = false;
      if (account !== undefined && account.disposable && link.origin === 'email')
        await ports.markAddressProved(tx, account.accountId);
      if (account === undefined) {
        account = {
          accountId: ports.secrets.newId(),
          universeId: ports.secrets.newId(),
          privacyEpoch: 1,
          disposable: link.origin === 'operator',
        };
        await ports.createAccount(tx, { ...account, address: link.address });
        accountCreated = true;
      }
      await ports.consumeLink(tx, tokenHash, { commandId: command.commandId, accountId: account.accountId });
      return enter(account, { origin: link.origin, accountCreated, address: link.address });
    };

    const outcome = await ports.withResolvedPersonalScope(
      resolve,
      async (scope, resolved): Promise<ScopeWork<RedeemSignInResult, RedeemRefusal>> => {
        const lookup = await ports.findReceipt(scope, key);
        let stored: RedeemOutcome;
        let replayed = false;
        switch (lookup.kind) {
          case 'key_reused':
          case 'epoch_mismatch':
          case 'outcome_version_older':
            return { kind: 'rollback', result: 'command_key_reused' };
          case 'outcome_version_newer':
            return { kind: 'rollback', result: 'outcome_from_newer_release' };
          case 'replay': {
            stored = RedeemOutcomeSchema.parse(lookup.outcome);
            // Only while the redemption's own session is live: a signed-out or revoked session
            // is never revived by replaying its request (review m5).
            const live = await ports.replaceCommandSessions(scope, {
              accountId: stored.accountId,
              commandId: command.commandId,
            });
            if (live === 0) return { kind: 'rollback', result: 'link_invalid' };
            replayed = true;
            break;
          }
          case 'new':
            await ports.insertReceipt(scope, key);
            stored = {
              accountId: accountOf(scope.authority.actor),
              universeId: scope.authority.universeId,
              accountCreated: resolved.accountCreated,
            };
            break;
        }
        const secret = ports.secrets.newSessionSecret();
        const sessionId = ports.secrets.newId();
        const { expiresAt } = await ports.issueSession(scope, {
          id: sessionId,
          accountId: stored.accountId,
          tokenHash: secret.hash,
          client: command.client,
          issuedByCommand: command.commandId,
        });
        if (!replayed) await ports.completeReceipt(scope, command.commandId, stored);
        return {
          kind: 'commit',
          value: {
            kind: 'signed_in',
            outcome: stored,
            privacyEpoch: scope.authority.privacyEpoch,
            session: { id: sessionId, token: secret.token, expiresAt },
            replayed,
            origin: resolved.origin,
            address: resolved.address,
          },
        };
      },
    );
    switch (outcome.kind) {
      case 'entered':
        return outcome.value;
      case 'stopped':
        return { kind: 'refused', reason: outcome.result };
      case 'refused':
        return { kind: 'refused', reason: refusalOf(outcome.refusal) };
    }
  };
}

function enter<C>(account: AccountRoot, context: C): RootResolution<C, never> {
  return {
    kind: 'enter',
    authority: {
      universeId: account.universeId,
      privacyEpoch: account.privacyEpoch,
      actor: { kind: 'account', accountId: account.accountId },
    },
    context,
  };
}

function accountOf(
  actor: { readonly kind: 'account'; readonly accountId: string } | { readonly kind: 'system' },
): string {
  if (actor.kind !== 'account') throw new Error('Sign-in scopes are always entered for an account');
  return actor.accountId;
}

function refusalOf(refusal: ScopeRefusal): RedeemRefusal {
  switch (refusal.kind) {
    case 'universe_missing':
    case 'universe_suspended':
    case 'account_mismatch':
    case 'epoch_changed':
      return 'account_unavailable';
  }
}
