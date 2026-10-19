import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';

/**
 * Identity's erasure declaration (blueprint §5). Identity's personal records are keyed by
 * account, not universe: the address, the sign-in links (which hold an address even before any
 * account exists) and the sessions. Clearing or resetting a universe must leave sign-in working,
 * so `erase` removes nothing; account deletion (the privacy work's own lifecycle) removes these
 * tables' rows for the account and its address, after locking the address and then the root
 * (identity's lock order). The personal roots (`identity.accounts`, `identity.universes`) are
 * the account-deletion lifecycle itself.
 *
 * Outside our database: every sign-in mail AgentMail sent stays in the `knowscroll@agentmail.to`
 * inbox's sent items under AgentMail's own retention. We keep no message ID to find it by, so no
 * eraser of ours reaches it; the privacy copy must say so rather than promise its removal.
 */
export const identityErasure: ModuleErasure = {
  module: 'identity',
  tables: [],
  accountTables: [
    { schema: 'identity', table: 'email_addresses', ownerColumn: 'account_id' },
    { schema: 'identity', table: 'sign_in_links', ownerColumn: 'address' },
    { schema: 'identity', table: 'sessions', ownerColumn: 'account_id' },
  ],
  // The operator audit (ops.operator_sign_ins, review m9) outlives clearing a universe; account
  // deletion keeps each row as a tombstone (account_id set to null).
  accountColumns: [{ schema: 'ops', table: 'operator_sign_ins', column: 'account_id' }],
  nonRowStores: [
    {
      name: 'agentmail/sent-sign-in-mail',
      description:
        "Copies of sign-in mail (address and an expired link) in AgentMail's sent items; provider retention, not erased by us",
    },
  ],
  erase(): Promise<{ readonly module: string; readonly status: 'completed'; readonly removed: number }> {
    return Promise.resolve({ module: 'identity', status: 'completed', removed: 0 });
  },
};
