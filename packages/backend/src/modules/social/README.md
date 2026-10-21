# Social: Friends backend foundation (#241)

Backend-only explicit profiles, exact handle lookup, current pair read and seven pair commands.
No routes or application providers are mounted. Invite input is validated strictly then explicitly
unsupported; lists, links, settings, presence, visitor publication, messaging and housekeeping are
future slices. Available friends carry constant unknown presence. No fabricated contact, seed,
world formation, grant, consumption or evidence follows from a command.

`socialUseCases` takes existing scope and Identity309 gate ports. Own profile changes lock own root
→ own account UPDATE → profile/receipt. Pair operations lock actor root → sorted two existing
account SHARE rows → separate fresh active/epoch read → one deterministic private pair root →
subordinate rows/shared receipt. No peer root, new fence table, lock upgrade, external wait or job.
The versioned SHA256 canonical-account UUID protocol is private; acquisition checks both UUID and
ordered account binding and fails closed on collision/mismatch. Public person UUIDs are separately
minted and contain no account/universe identity or email-derived handle. Profile revision0 means
explicitly unclaimed. Handles are exact lowercase ASCII3..24 with internal nonadjacent dot/underscore.
Labels preserve international text while rejecting C0/DEL/C1 and surrounding whitespace.

The private aggregate revision never appears on wire. `pairRevision` is one caller's public view.
A new request reserves one further public revision for deterministic expiry, then uses the approved fixed seven-day public window and same-expiry cooldown. Reciprocal
request never accepts. Recipient decline advances only recipient view; sender JSON, revision,
request ID, no-op retry and expiry remain identical to ignored history. Effective expiry is pure
server-time projection; commands persist it once and reads never depend on cleanup. Cancel has the
same sender semantics after private decline. A private block closes grants immediately while
preserving an existing pending sender projection through its deadline; no peer-block reason or
private-revision stale error is exposed. Remove is visible relationship withdrawal. Unblock clears
only own preference and restores nothing. No list snapshot/index or invalidation hint exists here.

Existing personal/shared receipts remain immutable outcomes, separate from current resources.
Pair command bindings fence actor epoch and authority lineage BEFORE receipt replay; request hashes
also bind actor epoch, never volatile peer epoch/private disposition. Old Accept after removal,
block or another lineage is unavailable. Actor-owned withdrawal/no-op completion can replay after
current active gates, but cannot grant access. Wrong expected public revision applies only to new
commands; an identical admitted retry returns the first outcome. Missing/inactive/blocked lookup
is one coarse branch. Withdrawals against an inactive peer also refuse; no cleanup bypass exists.

Migration0028 owns five tables, all account references RESTRICT. Request identity/expiry is immutable
and subordinate account membership is SQL-checked. No private profile/activity metadata is stored.
All account columns and lifetime tables are inventoried. Exploration clear retains them; registry
inventory is not a deletion executor. Full deletion needs future reviewed Identity maintenance and
shared-receipt purge capabilities. There are no scoped Social versions, jobs or caches in this slice.
Any future scoped store must erase ALL versions/epochs and fence late workers before application.

CI uses synthetic accounts in real disposable PostgreSQL. It is not two-account dev acceptance.
Migration/source presence does not roll out schema28, enable HTTP, or finish #241.
