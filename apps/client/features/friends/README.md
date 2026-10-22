# Friends UI (#377 / parent #241)

`/friends` is outside the four-tab group. Talk's real Friends link opens it; the always-reachable
Back control returns through router history, falling back to Talk. `/friends/invite` is the
explicit invitation entry page. Neither route implies that conversations are implemented.

The F01–F02 v2.1 artboard supplies the paper register, public-name/handle rows, primary Add action,
outlined controls, invitations and blocked/request states. This source uses existing tokens and
components with a 680px maximum measure, wrapping controls, 44px-or-larger targets, scalable text,
visible input focus and normal screen scrolling. F02 visibility, visits and live availability
have no current implementation: there are no fake switches, visitor permissions or presence dots.
All names/handles/relationships come from actual client-core reads. No contacts are uploaded.

One mounted scope-object-owned `FriendsSession` is created in an effect and disposed on cleanup;
StrictMode creates a fresh session instead of reviving a disposed one. Scope end fences responses
and removes private form/selection/token state. No Friends query cache, persistence, socket,
background polling, observation or provider call is introduced. Initial profile, invite and roster
reads are sequential because the core has one foreground read plus one latest queued selection.

Profile setup/edit, exact handle lookup, current pair actions and four roster filters use current
server revisions. All mutations go through the core. An immutable ACK clears all current fields;
sequential explicit reads refresh them before another choice. Unknown outcomes disable replacement
commands and expose only the core's same-body retry. No ACK is painted as current friendship.
Definitive refusals require Refresh current status before another mutation. List pages contain at
most 50 visible rows and retain at most eight previous cursors in core. Empty items with `canNext`
is an advancing scan, never the final empty state. Only deliberate Next/Previous/Refresh advances it.
No auto-drain, estimated totals, automatic acceptance or implicit relationship restoration exists.

Invite create/revoke uses current invite revisions. First delivery is held only by core until a
single deliberate Copy consumes it. A lost/replayed/copy-failed delivery requires deliberate revoke
then new create; no token is reconstructed or silently minted. Clipboard writes happen only when
requested; external clipboard copies cannot be recalled. Full links are never rendered or stored.
Web links are `/friends/invite#invite=ksfi_…`; initial and same-document hashchange fragments are
consumed and removed with replaceState, including invalid fragments and signed-out intake. Every
new/invalid fragment clears prior checked issuer, local selection and form drafts before callback
completion; intake never automatically checks or requests friendship.
Only the token enters the sensitive JSON resolve/request body. Resolve is pure; a separately labelled
Request action is mandatory. Editing/pasting/receiving another link invalidates the prior selection.
Signed-out entry discards the secret and asks the person to paste again after signing in. Native
uses the registered `knowscroll` scheme. Its OS initial-launch URL is consumed/discarded at most
once per process through an account-independent boolean-only fence; there is no token/URL/promise
cache or reset. Initial native links require deliberate paste again. StrictMode cleanup, account,
epoch and session remounts never reread or deliver that launch capability. Only fresh URL events
received by a current mounted active scope may fill its private input; removed/late handlers cannot
revive it. Actual native app-link handling remains unverified.

Meaningful authored fixtures cover empty scan advancement, unknown same-body command retry and fresh
reads, pure invite resolution, secret purge, native signed-out/account/epoch/session/StrictMode
remount and late-launch/event fences, signed-out and mounted second/invalid web fragment changes,
late prior resolution, fragment parsing and actual production
export controls. They run only in hosted Actions. Source/static/export build are not live Social,
native/physical, design-perfect or final privacy acceptance; Root owns connected journey acceptance.
