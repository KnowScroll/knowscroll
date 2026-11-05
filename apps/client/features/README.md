# Client features

Expo Router files under [`../app`](../app) choose the screen; feature folders implement the
journey. Begin with the route the person opened, then its screen, mounted session/controller
and the matching [client-core](../../../packages/client-core/README.md) operation. UI components
render values and report semantic actions; backend authority remains on the server.

## Find the owner

| Area | Start here | Journey or boundary |
| --- | --- | --- |
| Account | [account-screen.tsx](account/account-screen.tsx) | Identity, device preferences, sessions and the receipt that survives sign-out |
| Sign-in | [redeem-screen.tsx](auth/redeem-screen.tsx) | Explicit link redemption; opening a link alone does not redeem it |
| App navigation | [app-navigation.tsx](shell/app-navigation.tsx) | Tab/rail navigation and current route |
| Explore | [explore-screen.tsx](explore/explore-screen.tsx) | Mount the encounter or first-arrival screen |
| Encounter | [encounter-session.ts](encounter/encounter-session.ts) | Open offers, activate the chosen encounter, navigate and own its recorders |
| Direct Scroll | [scroll-screen.tsx](scroll/scroll-screen.tsx) | Open, activate, parse and render an exact Scroll revision |
| Direct Reel | [reel-screen.tsx](reel/reel-screen.tsx) | Playback grants and scoped player lifetime |
| Keep | [saved-screen.tsx](saved/saved-screen.tsx) | List actual saved items, restore a place and remove with Undo |
| Requests | [requests-screen.tsx](requests/requests-screen.tsx) | Private request receipts and current readiness |
| Universe | [universe-screen.tsx](universe/universe-screen.tsx) | Read geography/scenes, browse and claim formation presentation |
| Friends | [guide](friends/README.md) | Exact handle lookup, invitations, rosters and leased availability |
| Talk | [conversations-screen.tsx](conversations/conversations-screen.tsx) | Direct inbox and conversation screen |
| Threads | [thread-screen.tsx](threads/thread-screen.tsx) | Member-only discussion, coarse shared places and per-person reading |
| What if | [branch-screen.tsx](scenarios/branch-screen.tsx) | Open a thread branch; choosing a direction is separate from proposing one |
| Rooms | [room-workspace.tsx](rooms/room-workspace.tsx) | Shared room context for General, discussions, Today and activities |
| Sharing | [shared-links-screen.tsx](sharing/shared-links-screen.tsx) | List/revoke the person's links; API serves the public `/s` landing |
| Privacy | [guide](privacy/README.md) | Recording, export, Clear and deletion |
| Visibility | [guide](visibility/README.md) | Choose what friends may see; current server revisions govern writes |
| Friend visit | [guide](visit/README.md) | Read the owner's published copy; drop it on exit or refusal |
| Reports | [guide](feedback/README.md) | Report with one stable command ID; Not interested belongs to Experience |
| Operator | [operator-screen.tsx](operator/operator-screen.tsx) | Authorized diagnostic reads; no consumer scores or internal prompts |
| Galleries | [gallery-screen.tsx](gallery/gallery-screen.tsx) | Authored development examples behind export flags |
| Diagnostics | [folder](diagnostics/) | Development-only evidence inspection; export checks exclude it from production |
| Not found | [not-found-screen.tsx](not-found/not-found-screen.tsx) | Honest missing-page state |

For a complete cross-layer example, follow
[Account deletion](../../../packages/backend/src/modules/identity/README.md#account-deletion-d-043).
The session and scope authorize the start; the saved receipt allows coarse status/retry after
sign-out. Do not use a receipt response to revive account authority.

## Change a feature

Use the feature's existing mounted-resource pattern. Disposing a controller and ending an account
scope are different events: route-local resources end on cleanup; deliberately scope-owned state
may survive a route remount but must end with that scope. Late replies must not restore data from
an account or epoch that has ended. Browsing, offers and social activity never stand in for actual
reading. Keep play results out of recording and recommendation.

Run `pnpm --filter @knowscroll/client exec jest --ci --runInBand features/account` for a focused
component pass, replacing the last directory with the feature you changed. Full component checks
are `pnpm --filter @knowscroll/client test`; browser smoke tests use the built production and
gallery exports in `e2e/`. Native entry points include platform variants, Expo plugins and the
hosted emulator lane; Node or browser fixtures do not prove physical-device behavior.
