# Background bridge inquiries — evidence, 2026-09-24 (#132, ADR-0038)

Background reasoning that nobody tapped for, and the first real use of the reasoning runtime's
`background_inquiry` class and `dirty` wake. The reader turns on "Look for connections between my
places". When the Cartographer forms a new planet or region, that transaction mails one coalesced
inquiry. Once due, the worker rechecks its authority (consent for this epoch, recording not paused,
the route, the daily limit) and seals a small context: pairs of the reader's places that are not
yet connected, and the supported claims about them. It then sends exactly one request, never
replayed. The model can only propose. `bridge-validator-v1`, unchanged, admits or refuses through
`submitBridgeProposal` (`proposerKind = model`). An admitted bridge is the reader's own: it appears
as a continuation where either side is read, and "seems wrong" suppresses it. Privacy & account
lists every inquiry with its outcome.

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Pure | `tests/bridge-inquiry-core.test.ts` (14; mutants killed) | pair selection (unconnected, not ancestor/descendant, not suppressed, not already asked, a claim naming both and one of each side's own), deterministic request bytes with no identifiers, strict reply parsing, the admissible relations and directions, the system-composed proposal |
| Database, API, worker | `background-inquiries`, `-fairness`, `-recovery`, `-crash`, `inquiry-journey-editorial` (35 in total; fixture transport) | consent is the authority and nothing is backfilled; a burst coalesces into one inquiry after the delay; the daily limit; `nothing_to_ask` without a Job; found end to end and visible as a continuation; validator and shape refusals recorded with reasons; consent off, pause or Clear, both queued and in flight, and consent off-then-on or pause-then-resume during a call (the since-sealing guards; each deletion mutant fails its test); a reply after the Job's deadline closes as expired; a stale context never sent; no replay after a crash; a queue of background work never starves a direct Ask; erase and export |
| Android | 347 unit and Robolectric tests, lint | strict parsing; the consent change with a persisted retry, honest 409 and epoch purge; the section's wording for every status |
| Device, fixture | `KS_SEMANTIC_JOURNEY=inquiry` (`fixture-device/`) | see below |
| Live model | `scripts/run-live-inquiry-experiment.ts --live` (`live-runs/`) and the device journey with `KS_INQUIRY_TRANSPORT=minimax` (`live-device/`) | see below |

## The device journey (fixture)

The runner installs the fixture route (labelled) and places The Sun from a supplied account
**before** consent. The library cannot anchor The Sun from reading, and forming it before consent
proves nothing is backfilled.

On the emulator, Privacy & account shows the switch off with nothing looked for
(`inquiry-consent-off.png`). The reader turns it on (`inquiry-consent-on.png`), then reads their way
to Gravity as in the places journey. That real `place_formed` mails an inquiry, which goes from
waiting to looking to found. Privacy & account shows "The Sun and Gravity — Found a connection."
with the bridge's sentence and sources (`inquiry-found.png`). Where Gravity is read, the Connections
sheet offers the new continuation (`inquiry-continuation.png`).

The fixture's text is labelled "Fixture:".

SQL lineage (`fixture-device/receipt.json`), each value 1 unless stated:
- the inquiry admitted;
- its Job `background_inquiry` / `dirty` / `inquiry:bridge_between_places`, completed, through the
  last mail sequence;
- one attempt and one dispatch;
- the model proposal admitted, with `proposer_ref` the attempt;
- the reader's universe bridge admitted;
- the mail caused by Gravity's `personal_exploration` formation from the device's own reading;
- The Sun unread and never mailed (0 mails);
- consent recorded before the mail.

## Live (MiniMax-M3, the owner-authorised subscription route)

Every live request went through the worker's quota preflight and the shared session ledger. The
bounds were 16 KB and 4,096 output tokens, on disposable databases only. Receipts keep statuses,
validator reason codes, usage and hashes; no prompt, reply or mechanism is in Git.

| # | Request version | Outcome | Ledger |
| --- | --- | --- | --- |
| 1 | prompt v1 | did not hold up: `counterevidence_cited_as_support`, `direction_unsupported` | 29/40 |
| 2 | prompt v2: roles on claims naming both, only admissible relation types, the counterevidence rule | did not hold up: `direction_unsupported` | 30 |
| 3 | prompt v2 | did not hold up: `direction_unsupported` (it proposed The Sun explains Gravity; the claims give Gravity the mechanism role) | 31 |
| 4 | prompt v3: each pair's admissible relations and directions listed | did not hold up: `to_side_unsupported`, `direction_unsupported` (the list was ignored and the sides mislabelled) | 32 |
| 5 | prompt v4 / reply v2: the model picks an admissible entry by index and cites keys; the system composes the typed proposal | **found**: "Gravity explains The Sun", 6 sourced claims plus one counterevidence claim, admitted, and a continuation from 3 Scrolls | 33 |
| 6 | device journey, v4 | nothing found: the model answered "none" | 34 |
| 7 | device journey, v4 | did not hold up: `counterevidence_cited_as_support`; the journey passed, showing that outcome's line (`live-device/`) | 35 |

Runs 1–5 are the runner's receipts. Runs 6 and 7
covered the whole path on the device: the Android switch, API, worker, MiniMax-M3, the validator,
persistence, then the Android list. The first live device run failed a journey that then accepted
only "found". The journey now accepts any validated outcome on a live run, and checks the screen
shows it.

Reading of the live results: the validator did its job every time. No unsupported proposal became a
connection. The request had to become more structured before a live proposal could pass, because
MiniMax-M3 would not reliably keep direction or claim sides straight when asked in prose. With the
final format, three live requests gave one admitted bridge, one honest "none" and one refusal.

## Limits

- The Sun (and, in the live runner, Gravity) was formed from supplied accounts, labelled, because
  the library cannot anchor it from reading.
- A small editorial substrate: few candidate pairs. The live success rate is n=3, not a measured
  rate.
- Not in this slice: optional child inquiries, native provider continuation, other triggers, and
  the web client's controls.
- Debug API36 emulator, not a physical device.
