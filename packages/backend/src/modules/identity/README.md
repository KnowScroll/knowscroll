# modules/identity

Owns: `identity.accounts`, `identity.universes` (migration `0001_identity`). S1.3 adds
authentication on top; these names and columns stay stable.

Public surface (`public.ts`): `PersonalAuthority` (universe, privacy epoch, actor: account or
system), `PersonalScopeTx` (the branded capability of one locked personal transaction),
`ScopeRefusal`, `WithPersonalScope`, and `readAccountUniverse(db, accountId)` (read-only caller
lookup; its result is a claim that `withPersonalScope` rechecks under the lock).

Invariants: the universe row is the personal root. Its `status`, `privacy_epoch` and `revision`
follow the lock protocol in `infrastructure/postgres` (`withPersonalScope`,
`advanceScopeRevision`). Nothing cascades from it; deletion goes through the erasure registry.
