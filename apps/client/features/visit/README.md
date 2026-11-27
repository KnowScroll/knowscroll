# Friend visit (U06; #241, D-047)

`/visit/<handle>` shows a friend's universe: the systems and planets they chose to share, drawn by the
Universe's own renderer (`features/universe/`). The Friends screen's Visit button opens it by the friend's
public handle. Status marks: implemented with component tests over a labelled in-memory server; not
runtime-verified on dev.

| File                    | What it does                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visit-screen.tsx`      | The route screen: loading, the map under the visitor bar, "not shared", "stopped sharing", offline. Leave goes back, or to Friends when there is nothing to go back to                                              |
| `use-visit-sessions.ts` | Makes the visit's data session (client-core `createVisitSession`) and map session while the screen is mounted, and drops both when it leaves                                                                        |
| `visit-map-session.ts`  | The camera and selection of a visit: the `UniverseMapSession` the map is drawn from, over the list. No formation, no region cards, no Lately, no ship, nothing stored on this device                                |
| `visitor-scene.ts`      | Turns the public list into the renderer's descriptors. The list has no position, family or seed, so this device invents them from the public IDs alone: a place keeps its spot and look while it stays shared. Pure |
| `visitor-bar.tsx`       | One cream pill: Leave (dark, first in the tab order), "Visiting Ravi's universe / Only what Ravi shares", and the person's initial, which opens the options (Report). `VisitorPrivacy` is the one lock chip at the bottom, "Private parts stay private", with its explanation; it is the same on every visit, so it cannot say whether anything is hidden |
| `in-common.ts`          | `systemsInCommon(ownLabels, friendSystems)`: the friend's systems whose name you also have, in the friend's order, with case, accents and spacing folded as search folds them (`foldName`). Pure, names only, no count that ranks. The crossing film's drifting names are its `.label`s |
| `in-common-chip.tsx`    | The "What we have in common" chip (on: "Showing what you share"; on with nothing shared: "Nothing in common yet"): a 48 px two-state button |
| `use-own-system-labels.ts` | Where your own system names come from for that comparison: this account's own Universe session if the tab already loaded it, else one sky read of its own (the tab's read, nothing more), let go on the answer. Not called with the switch off |
| `visit-frame.tsx`       | Keeps the primary navigation on the visit page (U06): the floating tab bar on phones, the rail on tablets and desktops, Universe current. It carries no unread dot, because a visit reads only the friend's list          |

How it takes part in the journey: Friends row, then Visit, then one read (`POST /v1/social/visits/read`) that
the server checks again for friendship, blocks and the owner's audience. The screen rereads every 15 s while it
is open and the app is in the foreground, so an owner who stops sharing is noticed within that time, and it
drops the list after two minutes without an answer. Leaving, a refusal and the end of the account scope all
discard the list: it lives only in memory, so "nothing from it is kept on your side" is literally true.

**What we have in common** (Round 7.3, behind "Try the new Universe" only). At the whole-universe stop a chip dims the friend's systems whose names you do not have to 25 % light and their names to 0.4; the shared ones keep their light and wear a 2 px yellow ring (`CommonSky`, `universe/voyage/search-sky.tsx`, drawn under the names). While it is on, each shared system's button is named "<name>, a system, you have this too"; the chip is a button with `aria-pressed`. It is off when you arrive and when you visit another friend, hidden below the whole universe, and not shown when your own universe is empty or not in hand. Names are compared on this device; no read is added for it beyond your own sky read when the Universe tab has not loaded it, and no count is shown. Every system on your map counts, a hypothetical one included, as in search. In the new look the visit's map is pinned to the Light values like your own Universe (`printedSurface`), so it is the same in both appearances; the old look follows the appearance as before.

Not built: entering a room from a visit (this published view carries no room entry) and region cards (regions are never shared).
Visiting creates no evidence, observation or record for either person.

## Follow the request and check it

This feature uses the active account scope's client-core controller; the matching backend owner
checks the actual authority. Start with the [feature map](../README.md), then follow the screen's
session hook into [client-core](../../../../packages/client-core/README.md). A component fixture's
authored answer is not evidence that a live backend returned it.

From the repository root, run
`pnpm --filter @knowscroll/client exec jest --ci --runInBand features/visit`.
The app's hosted web smoke adds real browser/export checks. Keep privacy and failure assertions
intact; passing these checks does not establish a new dev or native-device acceptance.
