# modules/identity

Owns: `identity.accounts`, `identity.universes` (migration `0001_identity`). S1.3 adds
authentication on top; these names and columns stay stable.

Public surface (`public.ts`, framework-free): `PersonalAuthority` (universe, privacy epoch, actor: account or
system), `PersonalScopeTx` (the branded capability of one locked personal transaction),
`SharedScopeTx`, `ScopeRefusal`, `WithPersonalScope`, and the read ports `ReadAccountUniverse` and
`ReadUniverseAccess` (tokens `READ_ACCOUNT_UNIVERSE`, `READ_UNIVERSE_ACCESS`), implemented in
`adapters/postgres-store.ts` and bound by `adapters/nest-providers.ts` in the composition roots.
Their results are claims that `withPersonalScope` rechecks under the lock. The port type
`AuthorityHolds` (implemented by `makeAuthorityHolds` in `infrastructure/postgres`) answers the
same checks without a lock, for decisions that write nothing.

Invariants: the universe row is the personal root. Its `status`, `privacy_epoch` and `revision`
follow the lock protocol in `infrastructure/postgres` (`withPersonalScope`,
`advanceScopeRevision`). Nothing cascades from it; deletion goes through the erasure registry.

One universe per account (`universes_account_key`). Suspension protocol for S1.3: suspending an
account first locks its universe row (`FOR NO KEY UPDATE`), then changes the account status, so
a personal command that already passed its account check cannot commit after the suspension
(`FOR KEY SHARE` on the account alone does not conflict with that update). Sign-out, session
revocation and epoch changes call `revokeAccountSockets` in the same transaction, and S1.3's
caller adapter implements `sessionValid` (the API's AuthenticatedCaller port) over the session
record, so a socket whose revocation notice was lost is still refused on its next reconnect,
subscribe or re-authorisation.
