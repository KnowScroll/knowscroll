# Social: Friends backend foundation (#241)

Explicit profiles, exact handle lookup, current pair read and seven pair commands.
The API #374 adapter mounts these eleven operations using the existing use-case/provider ports.
Versioned roster pages and revocable invitation links are mounted by #377. Settings, live presence,
visitor publication and messaging remain future slices. Available friends carry constant unknown presence. No fabricated contact, seed,
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
only own preference and restores nothing. Roster indexing observes only each caller-visible side; no private aggregate revision or invalidation hint crosses the wire.

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
Migration/source presence does not roll out schema28 or finish #241. The installed API adapter
and disposable HTTP fixtures are distinct from two-account dev/client acceptance.

The API composition reuses Identity's existing own-account barrier and binds only the pair fence;
it does not mount account invalidation/deletion. Each output is closed-schema checked and bound
to current caller scope, original command/operation and selected public person. Central private
problem projection runs before auth/parsing for exactly the mounted methods/paths. Receipts remain
immutable and current pair/epoch/lineage authority is enforced by these owning use cases, not
reconstructed by HTTP. There is no list scan, cursor/index, provider, job or evidence path added.

## Recoverable rosters and invitations (#377)

`friend-pages.v2` is separate from the still-unmounted `sharing.v1` list declarations.
`POST /v1/social/friends/page` reads friends/blocked and `/v1/social/requests/page` reads incoming/outgoing.
Each pure read carries a fresh requestId, current account scope, filter and limit. It locks the
own root/Identity own-account gate and existing selected head before cursor decoding. It takes
no peer account/root or pair roots. At most250 current index candidates plus one lookahead are
read by stable public person UUID. Current active account/universe eligibility and current public
profile hydration happen within that bounded read, never by an unbounded status/profile fanout.
No visible item is proof of consumption, presence or continued friendship authority.

An empty page **can have next**; only absence of next exhausts the captured finite scan. The
authenticated next advances beyond the actually scanned/emitted candidate and retains the
original ceiling. There is no hidden-prefix cutoff masquerading as end-of-list. The public head
versions durable relationship-index writes; current metadata/eligibility are hydrated live rather
than frozen. Changing live eligibility before an already visited key requires a fresh traversal.
New pair/public-side mutations invalidate the old head. Profile edits, epoch/Clear/recording and
recipient-private decline/block do not fan out to peer heads. A private block preserves an
already-pending sender entry/deadline exactly. Established relationship withdrawal remains visible
without its private reason, as in the owning pair protocol.

The AES256-GCM process-private binary certificate binds protocol, account/universe/epoch,
filter/head/limit, advancing anchor/captured ceiling and traversal time bounds in164 base64url
characters. It expires within five minutes and no later than the earliest pending PUBLIC request
deadline. Expired, stale, malformed, foreign, changed-filter/limit or restarted-process cursors
uniformly refuse SHARING_UNAVAILABLE; refresh begins a new current traversal. No peer timestamp,
private revision, cursor grant, persistent cursor store, shared secret or model job is introduced.

0040 owns roster_entries (one current row/pair side), sparse roster_heads (at mostfour/account)
and invites (one latest row/account). Pair-side-only SQL projection/binding triggers commit public
index/head changes in the same transaction as pair effects/receipt. Side writes use canonical
account UUID order and affected head kinds use canonical order; each pair touches at mostfour
heads. Private no-ops do not bump sender heads. Indexed current rows, deadline minimum and exact
invite hash/account keys avoid relationship-history scans. Reads never materialize expiry.

Invites have one active link/account, random32-byte `ksfi_` tokens, SHA256-only storage and a fixed
seven-day absolute lifetime. Create requires an explicit profile, never replaces an active link,
and stores only an immutable acceptance in the personal receipt. Secret delivery is separate and
available only on the first fresh response; identical retry returns delivery unavailable. Lost
first delivery needs deliberate revoke then a new command. Old link commands cannot replay after
a replacement. Own status is pure, including effective expiry. Resolve and invite-target request
recheck current issuer/profile/token/expiry after existing Identity pair gates, before the sole
pair root or any replay/effect. Unknown/revoked/expired/inactive/blocked resolve uniformly returns
unavailable. A link never implicitly accepts friendship or restores withdrawn authority.

All new tables and account-linked columns are in the Social erasure inventory. Selective Clear
preserves populated index/invite/profile/pair state, while actor-epoch receipt binding still fences
old grant commands. Full deletion remains a separately reviewed maintenance/purge operation.
No token enters a URL, receipt, queue, hint or log. Hosted fixtures are synthetic accounts/PG;
source/schema/static checks do not establish real populated dev/client/native acceptance.
