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
| `visitor-bar.tsx`       | "Visiting Ravi / Only what Ravi shares", Leave, and the banner "Private parts stay private" with its explanation. The banner is the same on every visit, so it cannot say whether anything is hidden                |

How it takes part in the journey: Friends row, then Visit, then one read (`POST /v1/social/visits/read`) that
the server checks again for friendship, blocks and the owner's audience. The screen rereads every 15 s while it
is open and the app is in the foreground, so an owner who stops sharing is noticed within that time, and it
drops the list after two minutes without an answer. Leaving, a refusal and the end of the account scope all
discard the list: it lives only in memory, so "nothing from it is kept on your side" is literally true.

Not built: entering a room from a visit (there are no rooms yet) and region cards (regions are never shared).
Visiting creates no evidence, observation or record for either person.
