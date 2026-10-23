import type { ModuleErasure } from '../../../infrastructure/erasure/registry.js';
/** Account-lifetime inventory only. Exploration clear retains profile/membership. Deletion needs
 * a separately reviewed Identity maintenance barrier and infrastructure shared-receipt purge. */
export const socialErasure: ModuleErasure = {
  module: 'social',
  tables: [],
  nonRowStores: [],
  accountTables: [
    { schema: 'social', table: 'roster_heads', ownerColumn: 'owner_account_id' },
    { schema: 'social', table: 'roster_entries', ownerColumn: 'owner_account_id,peer_account_id' },
    { schema: 'social', table: 'invites', ownerColumn: 'account_id' },
    { schema: 'social', table: 'profiles', ownerColumn: 'account_id' },
    { schema: 'social', table: 'pairs', ownerColumn: 'low_account_id,high_account_id' },
    { schema: 'social', table: 'pair_sides', ownerColumn: 'account_id' },
    { schema: 'social', table: 'requests', ownerColumn: 'sender_account_id,recipient_account_id' },
    { schema: 'social', table: 'command_bindings', ownerColumn: 'actor_account_id' },
  ],
  accountColumns: [
    { schema: 'social', table: 'roster_heads', column: 'owner_account_id' },
    { schema: 'social', table: 'roster_entries', column: 'owner_account_id' },
    { schema: 'social', table: 'roster_entries', column: 'peer_account_id' },
    { schema: 'social', table: 'invites', column: 'account_id' },
    { schema: 'social', table: 'profiles', column: 'account_id' },
    { schema: 'social', table: 'pairs', column: 'low_account_id' },
    { schema: 'social', table: 'pairs', column: 'high_account_id' },
    { schema: 'social', table: 'pair_sides', column: 'account_id' },
    { schema: 'social', table: 'requests', column: 'sender_account_id' },
    { schema: 'social', table: 'requests', column: 'recipient_account_id' },
    { schema: 'social', table: 'command_bindings', column: 'actor_account_id' },
  ],
  erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),
};
