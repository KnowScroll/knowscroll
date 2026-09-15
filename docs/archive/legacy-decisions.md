> Historical decisions for Knowscroll-v2. These are provenance, not this repository’s operational instructions. New ADRs selectively adopt or supersede choices.

---
status: current
authority: architecture
---

# Decisions

**APPEND-ONLY.** To reverse a decision, append a new one whose `Supersedes` names the old ID.
Never edit or delete a line above. `Confirmed-by` names the journey, rule or test that will
catch it if the decision is silently violated — a decision with no confirmation mechanism is
a wish, not a constraint.

Format: `ID | date | Chose | Why | Rejected | Confirmed-by | Supersedes`

---

## D-001 | 2026-09-03 | SQLite (better-sqlite3 + Drizzle, WAL) as durable truth until Phase 3

**Chose.** One SQLite file, WAL mode, at `data/knowscroll.sqlite` inside the repo (gitignored).
The SSD is APFS (verified `diskutil info "/Volumes/Mrigesh SSD"` → `File System Personality: APFS`),
so SQLite locking is reliable there and the file may live on the SSD with the repo.

**Why.** One owner and four friends. A single file is easier to back up, restore and reason
about than a server; no Docker in the loop; drizzle-kit supports SQLite. ARCHITECTURE §2.2's
reasons for a modular monolith apply with more force at this scale.

**Rejected.** PostgreSQL now (ARCHITECTURE §1, §16.2 assume it): operationally heavier than
this user count justifies, and Docker Desktop would become a dependency of `pnpm dev`.

**Consequence that is not optional.** ARCHITECTURE §19.1 row-level security becomes
*application-level scoping by `user_id` on every query through the domain modules*. The schema
stays PostgreSQL-portable: no SQLite-only types cross a contract boundary.

**Reassess at the start of Phase 3** (H.3.1). If application-level scoping cannot be proven by
the adversarial journeys (S-21), move to PostgreSQL with real row-level security.

**Confirmed-by.** `pnpm drift` boundary rule (no raw table access outside its owning module);
journey S-21 (friend cannot reach owner's `user_hypothesis` / `observation_event`); journey 13
(deletion completeness).

**Supersedes.** — (deviation from ARCHITECTURE.md §1, §7, §19.1; cited there.)

---

## D-002 | 2026-09-03 | The job queue is a table, not Redis/BullMQ

**Chose.** One `job` table — `id, kind, payload, state, attempts, run_at, locked_at,
lease_until, error, parent_id, correlation_id, cost_cents` — claimed with `UPDATE … RETURNING`,
polled every 500 ms by the worker, with retry/backoff, a dead-letter state, and cancellation by
version guard (ARCHITECTURE §12.6).

**Why.** ~150 lines we own and can inspect, versus a second daemon whose failure modes we do
not control. The queue must never "decide product meaning" (ARCHITECTURE §2.1); a table makes
that structurally true. Lease-based claiming gives us cancellation and crash recovery for free.

**Rejected.** Redis + BullMQ (a second process to keep alive, and job state invisible to the
same transaction that writes receipts); an in-memory queue (loses work when the SSD unmounts).

**Confirmed-by.** Journey S-4 (job chain `reel.brief → … → reel.publish` visible in `/ops`);
the `/__system` endpoint reports live job kinds; worker restart mid-job re-leases rather than
duplicating.

---

## D-003 | 2026-09-03 | Social is Phase 3, built in full; its tables are designed on day one

**Chose.** The Phase-3 tables of ARCHITECTURE §7.7 (`friendship`, `visibility_policy`,
`visit_projection`, `share`, `blend`, `room_member`) are written into the day-one schema plan
(H.0.3) and their migrations are applied when Phase 3 starts. Invite-code login exists from
Phase 1 so friends can hold their own universes; nothing is shared until Phase 3.

**Why.** "Order is not scope" (Part B). Designing the social tables now is what stops Phase 3
from reshaping the Phase 1 schema. Deferring the *design* is what creates half-migrations.

**Rejected.** Adding social tables only when Phase 3 begins (guarantees a reshape of
`universe`, `relic` and `encounter` ownership columns); building sharing early (nothing to
share until the seed library exists).

**Confirmed-by.** The day-one schema plan in `db/PLAN.md` lists every §7 table with its phase;
`pnpm drift` fails if a §7 table has no entry.

---

## D-004 | 2026-09-03 | The hypothesis contract ships in full from Phase 1; rules propose first, models later

**Chose.** `user_hypothesis` rows carry kind, statement, confidence, sensitivity, evidence,
counterevidence, causal discount, decay and policy version (ARCHITECTURE §10.2) from day one.
In Phase 1 a small **versioned rule set** proposes hypotheses and typed `world_delta`s from the
observation/exposure ledger:

- a place is born when three encounters anchor to one concept cluster;
- two places join when a branch crosses them;
- a "stuck on" mark appears when a kept question stays unanswered;
- a ruin appears when a prediction is revised against evidence.

In Phase 2, model-driven `inference_run`s propose through the **same** typed proposal and
policy gate. Restricted hypotheses never influence ranking without an explicit policy;
prohibited ones are never written (README Law 11, ARCHITECTURE §10.2).

**Why.** The contract is the safety property, not the proposer. Shipping a thin hypothesis row
in Phase 1 and widening it in Phase 2 would mean rewriting every consumer, and the widened
fields (counterevidence, causal discount, decay) are exactly the ones that prevent a
self-confirming universe (RESEARCH §2.3).

**Rejected.** Model-proposed hypotheses in Phase 1 (unbenchmarked, and RESEARCH §13.3 lists
calibration and false-intimate-inference rate as unknown); a simplified Phase 1 hypothesis row.

**Confirmed-by.** Journeys 7, 11, 12; a contract test asserting no `user_hypothesis` row can be
written without evidence refs and a decay policy; a test asserting `sensitivity: prohibited`
output is dropped to an evaluation row and never to user state.

---

## D-005 | 2026-09-03 | Vercel AI SDK v7 is the language-model layer; the job table is the harness

**Chose.** `ai` (Apache-2.0) for every model call: `generateText` + `Output.object(schema)` for
shot list, script, judge verdict and reconciliation; a tool loop with a step cap and two tools
(`search`, `fetch_page`) for the research episode; the evaluator–optimizer pattern for
judge → regenerate with a bounded iteration count. Persist `result.steps`,
`result.response.messages` and `usage` as a `model_receipt` row per call. Orchestration is the
job table (D-002), not an agent framework.

**Why.** The pipeline is a state machine with schema-shaped model calls between the states and
exactly one bounded tool loop. That shape wants a typed SDK and a durable queue, not a
long-lived agent process (`docs/research/harness-sdks.md` §7–8).

**Rejected.** prime-agent (no npm distribution, Python kernel, ships Claude Code impersonation
for OAuth); OpenCode's SDK (spawns a sidecar; tools live in its process); the Codex SDK
(MCP-only tools); the Claude Agent SDK (proprietary licence, policy-volatile — it is not part
of the product runtime; the Claude Code sessions *building* the product are a separate matter).

**Fallback, pre-authorised.** Keep pi's agent core (`@earendil-works/pi-agent-core`, MIT)
behind the same port for a genuinely open-ended research step. **Adopt it the moment the AI SDK
loop fails a research brief twice**, and record that as a new decision.

**Confirmed-by.** Every model call writes a `model_receipt`; a test asserts no provider SDK is
imported outside `packages/providers`; `pnpm drift` forbids `apps/api → providers`.

---

## D-006 | 2026-09-03 | Model routing across the MiniMax family

**Chose.** All text and vision through one `LanguageModelPort`; the model id is recorded in
every receipt.

| Role | Model |
|---|---|
| Visual Witness, Encounter Reconciler, keyframe judge | `MiniMax-M3` (the only vision model) |
| Research episode planner, script + shot list | `MiniMax-M2.7` |
| Claim extraction over fetched pages, caption plan, Ask answers, branch briefs | `MiniMax-M2.7-highspeed` |
| Anything over ~200k tokens of sources | `MiniMax-M3` (1M context) |

**Why.** M3 is the only model in the family that accepts images and video, so the two gates
that protect epistemic truth (Witness, Reconciler) must use it. Ask must feel instant, so it
takes the highspeed variant. Nothing else needs 1M context.

**Rejected.** M3 for everything (slower and dearer with no quality argument for short text);
a second vendor (the owner's key is MiniMax and the token plan covers this family).

**Provisional until benchmarked.** RESEARCH §13.4's ten-task benchmark runs in Phase 2.1 and
its results are recorded in `docs/research/model-benchmark.md`. This table may change then.

**Confirmed-by.** `generation_receipt.model` / `model_receipt.model` on every row; the Phase 2.1
benchmark.

---

## D-007 | 2026-09-03 | `fal-ai/minimax-h3-turbo/*` is the only video path, 768P only

**Chose.** Video comes from fal's H3 Turbo alias — `image-to-video` as the workhorse,
`text-to-video` for establishing shots, `reference-to-video` for character-heavy shots.
Always at **768P**. Never 2K or 4K. `resolution` is always set explicitly because the official
endpoint defaults to 2K.

**Why.** MiniMax's token plan explicitly excludes H3 video and its pay-as-you-go keys are not
interchangeable with subscription keys, so fal is the only path the owner's keys can reach.
768P is the cost floor that still fills a phone screen; 2K would blow the $40 seed budget.

**Rejected.** MiniMax direct `api.minimax.io/v2/video_generation` (pay-as-you-go only, excluded
by the owner's plan); `minimax/hailuo-03/*` (legacy, 2K only, no seed); one 15 s clip per reel
(no continuity control, and the cap is hard).

**Unverified until Phase 0.2.** The alias page renders no price. Confirm the observed rate from
the fal dashboard after the first job and write it into `BUDGET.md`.

**Confirmed-by.** `generation_receipt` carries model slug, resolution, duration, seed and cost;
`pnpm cost` fails if any receipt shows a resolution other than 768P.

---

## D-008 | 2026-09-03 | Narration is the app's T2A track; H3's native audio is ambience only

**Chose.** Every shot prompt ends `non_diegetic_music: N/A` and states "no dialogue, no speech,
no music". Narration is generated separately by MiniMax T2A with word-level timestamps, and
H3's native audio is ducked under it during ffmpeg assembly. Captions and the sources end card
are burned by ffmpeg from the app's own text, never asked of the model.

**Why.** Word timestamps are what make captions accurate and accessible (ARCHITECTURE §23.3),
and H3 cannot produce them. On-screen text from the model garbles (Part F.6). Keeping narration
outside the model also keeps the claim→sentence mapping auditable.

**Rejected.** H3 native off-screen voiceover (no word timestamps, reported weaker on
Turbo/Max). Reserved for a later bake-off on character-led reels only, and only with a decision.

**Fallback if T2A is not covered by the owner's plan.** `kokoro-js` (free, local) for audio +
`whisper-cli` to derive word timestamps. The pipeline keeps running either way.

**Confirmed-by.** Phase 0.2 spike records T2A coverage in STATE; every `reel_asset` has a
`caption_key`; a test asserts no shot prompt omits the negative audio block.

---

## D-009 | 2026-09-03 | Invite-code auth; no email, no OAuth, no passwords

**Chose.** An `invite_code` table mapping codes → users, exchanged for a session cookie. The
first code is the owner's. Friends get their own code and their own universe from Phase 1;
Phase 3 adds friendship and visibility policy on top of the same identities.

**Why.** Five people. Email/OAuth would add a provider, a secret and a failure mode to protect
an account that has no value to anyone else. Private-by-default scoping (D-001) is the real
access control, and it is independent of how someone logged in.

**Rejected.** OAuth (a third-party dependency in the login path for five users); passwords
(a hashing story and a reset story for no gain); no auth at all (Phase 3 needs stable
identities, and D-003 says do not reshape later).

**Confirmed-by.** Journey S-21 (a friend's session cannot reach the owner's private tables);
journey 13 (deleting an account removes its codes and derived state).

---

## D-010 | 2026-09-03 | SERPdive is primary search; Exa is the second index for opposition

**Chose.** SERPdive `POST api.serpdive.com/v1/search` as `SearchPort`'s primary — `krill` (free,
~700 tokens) for Ask's quick lookups, `moby` (1.5 credits, full readable page text with dates
and a cited answer) for the research step. Exa as the **second, independent index**, used
deliberately for primary sources and the credible-opposition pass. Fetch: Jina Reader
(`r.jina.ai/<url>`, no key, 20 rpm) for URL → markdown; Firecrawl only for JavaScript-heavy
pages; `defuddle` for local extraction; `yt-dlp --write-auto-subs --skip-download` for YouTube
transcripts, stored as a `source_snapshot` with the video URL and retrieval time, never as media.

**Why.** One `moby` call returns dated sources *with content*, which is exactly what claim
extraction needs, and 1,000 free credits a month covers the seed library. RESEARCH §14.2 and
ARCHITECTURE §14.2 require searching for credible opposition, not just confirmation — and two
independent indexes beat one at surfacing disagreement.

**Rejected.** A single index (confirmation-shaped results); scraping without a reader (rights
and quality); storing copyrighted source bodies (ARCHITECTURE §14.2 forbids it — store the
snapshot hash and locator).

**Confirmed-by.** `research_run` receipts record which index answered each claim; a test asserts
every `ResearchResult` with a `disagreements` entry cites at least two distinct sources;
retrieved text is marked untrusted at the port boundary.

---

## D-011 | 2026-09-03 | A nightly bounded tick, not Headlong, is how worlds change while away

**Chose.** The first world tick is a **night tick**: a scheduled bounded episode (launchd,
03:00) that reads yesterday's observation ledger, picks one unresolved question or one blank
region, runs the research step, prepares one Tier 1 branch plan or proposes one typed
`world_delta`, and writes a Chronicle entry the person sees next morning — "A path changed
while you were away". Budget ≤ $0.50 a night, ≤ 8 steps, receipts like any other job.

**Why.** This is what the owner actually wants (README Journey E) in its smallest honest form:
ARCHITECTURE §9.2 and §16.7 — "a scheduler, not an immortal prompt".

**Rejected.** Headlong as orchestrator or as the world agents. It is a never-sleeping loop that
executes the shell commands a model writes; at $1–2/hour of background thinking it would burn
the entire $40 seed budget in a day, and it stopped its own service three times in its authors'
own trial. That is the opposite of ARCHITECTURE §3 invariant 9 (every autonomous run has a
budget, deadline, allowed tools, schema, risk tier and receipt).

**Borrowed anyway.** Two of Headlong's ideas are good and already ours: the trajectory as an
append-only DAG (pi's session trees), and "external messages are observations in one stream"
(the observation ledger).

**Queued, not cut.** A Headlong-style resident per world is a Phase 2+ experiment *after* Idea
Rooms exist: sandboxed, spend-capped at cents/hour, with exactly one output channel — typed
`world_delta` and branch proposals through the normal risk gates — and authority over nothing.

**Confirmed-by.** Journey S-14 (night tick runs inside budget and step cap and writes a
receipt); `pnpm cost` caps nightly spend.

---

## D-012 | 2026-09-03 | The Hybrid two-register design is the design; the first tab is "Atlas"

**Chose.** Two registers on one palette. *Where things are* (universe, zoom, world, region,
rift overlay) is the **survey sheet**: cream ground, printed grid, coloured diagonal hatch per
region, 3 px outlines, numbered references with a key, scale bar, sheet number. *A thing itself*
(reel, scroll, school, kept thing, Ask, Rest, controls) is the **Kiosk poster**: flat colour
fields, one huge headline, thumb-sized targets, no grid, truth state carried by card shape.
Tabs: **Atlas · Watch · Ask · Keep**.

Palette: ink `#111214`, cream `#FFFBF0`, overlay cream `#EFEADE`/`#E8E4DA`, blue `#2C46E8`,
green `#14C79B`, yellow `#FFE44D`, red `#C2341A`. Type: Bricolage Grotesque (self-hosted
woff2) for headlines and body, a monospace for small-caps labels.

**Why.** "The grid is the tell. When it appears you are navigating; when it goes you are
consuming." That single rule solves ARCHITECTURE §13.7's transition problem visually, and
README Law 14 (orientation survives every transition) needs exactly this kind of persistent
signal.

**Rejected.** The Kiosk-only set (labels the first tab "World" and has no survey-sheet register
for navigation, so zoom has no visual grammar).

**Confirmed-by.** Journey S-9 (grid leaves through the threshold morph and returns on back);
`packages/ui` owns the tokens and the eight truth-state card shapes as components.

---

## D-013 | 2026-09-03 | The eight truth states are card *shapes*, not colours

**Chose.** `truth_state` maps to a structural card shape, and colour is never the only signal
(ARCHITECTURE §23.3):

| UI copy | `truth_state` | Shape |
|---|---|---|
| checked out | `documented` | hard outline, square corners, green pill |
| put together | `synthesis` | card inside a card (double outline) |
| a view | `interpretation` | no outline, quote bar, sunk ground |
| still argued | `disputed` | card split down the middle, red lower half |
| a model | `modelled` | cut corner, graph-paper ground |
| didn't happen | `counterfactual` | tilted, dashed outline, "off the record" |
| made up | `fictional` | blob corners, yellow ground |
| we got it wrong | `correction` | yellow band "fixed 12 aug", struck original |

**Why.** README Law 9 says a compelling presentation cannot upgrade a weak claim. If truth
state were a colour or a label, a redesign could quietly erase it. As a shape it is structural
— you cannot render a disputed claim as a documented one without building a different card.

**Rejected.** A coloured pill alone (fails colour-blind users and ARCHITECTURE §23.3);
a text label alone (invisible at a glance in a stream).

**Confirmed-by.** A visual journey renders all eight shapes; a contract test asserts every
`encounter.truth_state` resolves to exactly one registered card component.

---

## D-014 | 2026-09-03 | The $40 seed budget, enforced in code

**Chose.** Caps live in `steering/BUDGET.md` and are enforced by the worker before every paid
call, not only reported afterwards: seed library ≤ **$40** total; per-day ≤ **$10**; per
requested branch ≤ **$3**; per reel ≤ **$3.00** all-in; retries ≤ 2 per shot; never 2K/4K.
Exceeding any cap stops the job and writes a question to `QUESTIONS.md` — it never silently
degrades quality or silently overspends.

**Why.** At Turbo 768P a 40 s reel of five clips is $1.60 of video plus $0.15 per keyframe plus
retries. Twelve reels fit in $40 only with discipline: 4–6 shots per reel, text-to-video for
establishing shots, keyframes only where continuity needs them, and keyframes judged before
animating. A budget that is only a document is not a budget.

**Rejected.** Budgeting on the launch promo rate (~a quarter of regular); reporting-only cost
tracking (ARCHITECTURE §27 lists budget exhaustion through branch generation as a known risk).

**Confirmed-by.** `pnpm cost` totals every `generation_receipt` against the caps and exits
non-zero over any of them; the worker's pre-flight check refuses a job whose estimate breaches
a cap.

---

## D-015 | 2026-09-03 | The H3 pipeline is pulled forward into Phase 1 for the seed library

**Chose.** The full reel pipeline (stages 1–10) including the Visual Witness and Encounter
Reconciler gates runs in **Phase 1**, not Phase 2. Every seed reel the owner will ever watch
is produced by it.

**Why.** ARCHITECTURE §25 and README Phase 1 defer H3, but Phase 1's deliverable requires
"sourced Reels" and the owner ruled out hand-authored content. The invariant that H3 protects
is *"never in the swipe path"* — and seeds are generated offline through the job boundary, so
that invariant holds. Building the seed library any other way would mean building it twice.
The gates come with the pipeline, not after it: an ungated generated reel is exactly the
failure ARCHITECTURE §17.4 exists to prevent.

**Rejected.** Hand-authoring the seed library (proves nothing about the pipeline, and Part B
says the pipeline *is* the product); shipping seeds without Witness/Reconciler (README Law 9).

**What stays in Phase 2.** Generated branches on demand, series, Tier 2 speculation,
world-tick output. Phase 1 generates *offline*; Phase 2 generates *in response*.

**Confirmed-by.** Journeys S-4 and S-5; every `reel_asset` in the seed library resolves to a
`witness_observation` and an `encounter_reconciliation` row.

---

## D-016 | 2026-09-03 | The mockups' content is placeholder; the shipped worlds are the owner's four

**Chose.** The four seed worlds are **Predictive History, Coding, Startups, Anime** (H.1). The
1940 / Filter Room / "The side with more tanks lost" / "Rina" content in the design sets is
the designer's frame-filler. Keep the card grammar, the labels and the microcopy patterns
("checked out · 3 sources", "you carry all of this with you", "we don't count what you never
saw", "Blank is honest") exactly; swap only the content.

**Why.** `docs/design/DESIGN_CONTRACT.md` line 70 suggests reusing 1940 as seed world #1 "so
the shipped app matches the mockups pixel-for-word". `PROMPT_SESSION_00.md` Part E and H.1
override this: the owner chose the four worlds, and Part I lists them under "already decided,
do not re-ask". The later, more specific instruction wins.

**Rejected.** Shipping the 1940 world as seed content (the owner did not choose it, and a
world exists to be one the owner actually wants to fall into).

**Confirmed-by.** `db/seeds/briefs/*.json` contains only the four worlds; a test asserts no
seed brief references the placeholder content.

**Supersedes.** — (resolves a conflict in `docs/design/DESIGN_CONTRACT.md` §"Example content".)

---

## D-017 | 2026-09-03 | Three phases, one order, nothing cut — sequencing is the only freedom

**Chose.** The whole README is the target, built in the README's own order: validation gate →
Phase 1 → Phase 2 → Phase 3 → converge. A later phase is never "deferred"; it is queued behind
proof of the earlier one, and its schema and contracts are designed from the start so nothing
is reshaped when it arrives. Anything that must wait goes in a feature file and `QUESTIONS.md`
with the reason and the phase it is queued for.

**Why.** The owner's instruction is explicit and was reaffirmed under "already decided, do not
re-ask". The failure this prevents is Failure B: a later session sampling the repo, finding
Phase 2 absent, and concluding it was cut.

**Rejected.** Scoping down to a "v1" (the owner ruled it out); building phases in parallel
(each phase's gate evidence is what justifies the next).

**Confirmed-by.** `pnpm state` lists every phase with its status; a phase cannot be marked
started until the prior phase's deliverable has a proof manifest.

---

## D-018 | 2026-09-03 | The H3 endpoint is verified on day one, with `minimax/h3-max-turbo/*` as the named fallback

**Chose.** Keep `fal-ai/minimax-h3-turbo/*` as the production path (the owner chose it and holds
a key for it), but treat it as **unverified until the Phase 0.2 spike proves it**. If the alias
fails, is unpriced at the dashboard, or bills above the Turbo rate, fall back to
`minimax/h3-max-turbo/text-to-video` and `minimax/h3-max-turbo/image-to-video` and record the
switch as a new decision.

**Reference-to-video is a separate, dearer endpoint.** `minimax/h3-max-turbo/reference-to-video`
**does not exist** (404). The only reference path is `minimax/h3-max/reference-to-video` at
**$0.08/s — twice the workhorse rate — plus token-billed references**. Part F's table implies it
sits alongside the $0.04/s workhorse; it does not. Reference-to-video is therefore used only
where a character-heavy shot genuinely needs it, and its cost is estimated at 2× before the job
runs (D-014's pre-flight check).

**Why.** `docs/research/extracts/minimax-h3.md` found the alias renders no pricing block, is not
in fal's "Recently Added", and its page title is literally "Minimax H3 Turbo (Unknown) API on
fal", while its schemas are byte-identical to `minimax/h3-max-turbo`. That is consistent with an
alias, but "consistent with" is not "verified", and the difference is billed to the owner.

**Three schema facts that change the pipeline** (from the live fal OpenAPI schemas, correcting
Part F.2):

1. **`image-to-video` has no `aspect_ratio` field at all.** The output ratio follows `image_url`,
   and when `image_url` is omitted the request is handled as text-to-video at **16:9**. A
   vertical reel therefore requires either `text-to-video` with `aspect_ratio: "9:16"` or a
   genuinely 9:16 keyframe. A non-vertical or missing keyframe silently yields a 16:9 clip.
2. **`text-to-video` and `image-to-video` never return a `seed`.** Only `reference-to-video`
   does. Seed reproducibility depends on the caller generating the integer and persisting it in
   the receipt; it cannot be recovered from the response.
3. **`timings` is nullable** ("Null on routes that do not report backend timings"), so
   `timings.inference` is an optional receipt field, not a required one.

**Also corrected.** `prompt` maxLength is 50,000 on fal (MiniMax direct caps at 7,000 — keep
7,000 as our ceiling); `prompt_expansion_mode` is **required** with default `balanced`; webhook
retries are bounded by result expiry (~6 minutes for results ≥10 KB, not a flat 31 tries);
output URL lifetime is settable per request with the
`X-Fal-Object-Lifecycle-Preference` header rather than only by an account default.

**Confirmed-by.** Phase 0.2 spike `h3-image-to-video` records the resolved slug, the observed
dashboard charge, `expanded_prompt`, and whether `timings` and `seed` came back; a contract test
asserts every submitted `image-to-video` job carries a 9:16 `image_url` or is routed to
`text-to-video`; every `generation_receipt` carries a caller-generated seed.

---

## D-019 | 2026-09-03 | Phase 0.2 spike results — what is now verified rather than assumed

Every claim below was made by a real call on 2026-09-03, recorded in
`docs/research/spike-results.json`. Nothing here is from a doc.

### The fal H3 schemas are exactly as D-018 predicted — all six points confirmed

Read live from `fal.ai/api/openapi/queue/openapi.json` for each slug:

- **`fal-ai/minimax-h3-turbo/*` — all three endpoints exist**, including
  `reference-to-video`. The owner's chosen alias is complete; D-007 stands.
- **`minimax/h3-max-turbo/reference-to-video` → HTTP 404**, confirmed. The non-alias Turbo
  family genuinely has no reference endpoint.
- **`image-to-video` has no `aspect_ratio` field** on either
  `fal-ai/minimax-h3-turbo/image-to-video` or `minimax/h3-max-turbo/image-to-video`. Confirmed
  live. **This is the trap that would have shipped a 16:9 clip into a 9:16 product.**
- **`text-to-video` and `image-to-video` return `video, timings, expanded_prompt` — no `seed`.**
  `reference-to-video` returns `video, seed, timings, expanded_prompt`. Seeds must therefore be
  caller-generated and persisted to be reproducible.
- **`prompt_expansion_mode` is required** alongside `prompt` on every endpoint.
- `resolution` is `480P|768P` default `768P`; `duration` is 5–15 default 5; `prompt` maxLength
  is 50,000 (we keep MiniMax's 7,000 as the working ceiling).

**Still unverified: the price.** The alias renders no pricing block. One 5-second job plus a
dashboard read is the only way to settle it (Q9), and the seed library does not run until it is.

### T2A speech IS covered by the owner's token plan — Q3 answered, no fallback needed

`POST https://api.minimax.io/v1/t2a_v2` with `model: speech-2.8-hd` and `subtitle_enable: true`
returned **110 KB of audio and a `subtitle_file` URL**. Word-level timestamps are given to us.

**Consequence.** D-008's primary path is live: narration is real T2A with real word timings, and
the `kokoro-js` + `whisper-cli` fallback stays unbuilt until something breaks. No pay-as-you-go
key is needed. `minimax_paygo_api_key` can stay absent.

### All three MiniMax text models work on the OpenAI-compatible `/v1` wire

`MiniMax-M2.7-highspeed`, `MiniMax-M2.7` and `MiniMax-M3` all returned 200 with usage reported
(M3 additionally reports `reasoning_tokens` and `cached_tokens`). The token-plan key covers all
three. D-006's routing table is reachable.

**One finding that changes the pipeline: all three models emit `<think>…</think>` blocks.**
A 16-token cap was consumed entirely inside the reasoning block, so no answer survived. Every
structured-output call must therefore either disable thinking or strip the reasoning prefix
before parsing, and every `max_tokens` must budget for reasoning on top of the answer. A schema
call that "returns nothing" will be this, not a schema failure.

### SERPdive is at capacity; Exa and Jina work — which is why D-010 has two indexes

- **SERPdive: HTTP 502 then 503 `server_busy`** on `krill` and `mako`, three retries apart,
  with "failed requests are never billed". **The key is valid** — an intentionally bad key
  returns 401 `invalid_api_key`, ours returns 503 — so this is provider capacity, not our
  account. `POST /v1/search` is its only endpoint; there is no credits endpoint to check.
- **Exa: 200.** Three results for the Turchin query, the first two being the actual *Nature*
  letter and the author's PDF of it — primary sources, which is what it is there for.
  Cost reported inline: `$0.007` for a neural search.
- **Jina Reader: 200**, 45 KB of clean markdown for a Wikipedia article, no key required.

**Consequence for `SearchPort`.** The two-index design is load-bearing, not redundancy theatre:
on day one the primary index was down and the second one answered. The port must treat 502/503
as retryable with backoff and **fall through to Exa rather than failing the research step**, and
every `research_run` receipt records which index actually answered so a later session can see
that the seed library was researched through the fallback.

**Confirmed-by.** `docs/research/spike-results.json`; the search adapter's contract test asserts
a 503 from the primary produces an Exa-answered result rather than an exception.

---

## D-021 | 2026-09-03 | Two steering-system fixes found by the first child session

C.6 says: *"If the loop does not close cleanly, fix the system, not the slice."* The loop did
close, but the child session that closed it reported four rough edges in the machinery. It
correctly declined to fix them — changing the hooks or `journey.mjs` is its own change with its
own gates — so the founding session fixed the two that would compound.

### The stop-gate ratchet

**Was.** `stop-gate.sh` demanded a `<today>`-dated PASS bundle for **every** feature whose
Status is `verified`. Bundles are gitignored (D-014's proof rule), so every session had to
re-run every previously-verified journey to be allowed to end, and a fresh clone started fully
blocked with no way to satisfy the gate except re-running everything.

**Observed, not predicted.** The child session had to run `pnpm journey system-truth` for a
feature it never opened, purely to be allowed to stop. At two features that is a few seconds.
At thirty it is the whole session, and the pressure it creates is toward weakening the gate —
which is the one thing the gate exists to prevent.

**Now.** The stop-gate demands a today-dated passing proof only for features **touched this
session** (dirty in the working tree, or committed since 00:00 today). Untouched verified
features are still audited, by `pnpm proof`, which checks that their newest manifest is a PASS
and is not older than the feature's last change. Nothing stops being checked; the check simply
stops being a treadmill.

**Rejected.** Keeping the ratchet and committing the bundles (they hold screenshots of the
owner's runs; the repo is public). Dropping the check entirely (then `verified` means nothing).

### The ritual demanded a red the machinery could not record

**Was.** Ritual 7 says never write a test that passes against pre-change code. Ritual 4 says a
FAIL is where you stop and report. So demonstrating the red through `pnpm journey` wrote a FAIL
manifest, appended a FAIL evidence line and filled `Divergence` with a divergence that was not
one — **the ritual's most important rule was the single thing the evidence machinery could not
express.**

**Now.** `pnpm journey <slug> --red` runs the spec expecting failure. A genuine failure is
recorded as `journey=RED (expected, pre-change)` in the feature's Evidence and exits zero. An
**unexpected pass exits non-zero**, because a test that passes against unchanged code does not
discriminate and would have proven nothing — that is the real error, and it is now the one the
tool shouts about.

A bug found while testing this: the first implementation wrote the "RED (expected)" evidence
line even on an unexpected pass. Evidence is append-only, so a false line there is permanent —
exactly the fiction the mode exists to prevent. The line is now written only when the red
actually happened, and both directions were tested against a throwaway spec before this was
trusted.

**Still open, recorded by the child in QUESTIONS.md Q11:** two further findings about the proof
mechanism that need their own gates.

**Confirmed-by.** The ratchet fix was verified by simulating a later date, where a verified
untouched feature is no longer demanded; `--red` was verified in both directions — a genuinely
failing spec records RED and exits 0, a passing one reports UNEXPECTED PASS and exits 1 without
writing evidence.

---

## D-020 | 2026-09-03 | A feature is proven by a journey carrying that feature's own slug

**Chose.** A feature's proof is a journey whose slug equals the feature file's name. No feature is
ever proven by another feature's journey. A feature that has no journey of its own does not reach
`verified` — it stays at its prior status and the feature file says why.

**Why.** `scripts/journey.mjs` keys the proof directory, the Evidence line and the Status flip to
the *journey's* slug; `.claude/hooks/stop-gate.sh` keys its check to the *feature file's* name.
The two only meet when the slugs are identical. A gate that names a different feature's journey as
its proof produces a bundle filed under the wrong feature and a feature that can never legitimately
read `verified`. Found by the C.6 child-session test, whose own Gate 4 had exactly this defect: it
said "prove this with `pnpm journey system-truth`", which would have written
`proof/<date>-system-truth/` and flipped a different feature's status while leaving
`system-runtime-facts` permanently unverifiable.

**Rejected.** Extending an existing feature's journey with the new feature's assertions — it parks
one feature's measure inside another's proof and couples them permanently, so changing feature A
means editing feature B's evidence. Leaving a feature at a non-verified status when its journey
lives elsewhere — a null result, and for a C.6 test a failure of the thing being tested. Renaming a
feature file, or folding a feature into an existing feature's file, so that the slugs match — it
produces a green stop-gate by destroying one-feature-per-file, which is the rule this decision
exists to protect rather than to trade away.

**Consequence that is not optional.** A queue stub filed under D-017 has no journey and therefore
cannot reach `verified`. That is correct and intended: `steering/features/truth-node-engine.md` and
`steering/features/system-runtime-abi.md` are the first two features to live in that state.

**Confirmed-by.** Every feature file with `Status: verified` has a proof bundle whose slug equals
the feature file's name.

---

## D-022 | 2026-09-03 | A provider's response can carry a third party's secret — redact at the boundary

**What happened.** The T2A spike stored MiniMax's `subtitle_file` verbatim. That field is a
**presigned Alibaba OSS URL** whose query string carries `OSSAccessKeyId` and `Signature` — a
live credential belonging to MiniMax, written into a file committed to a **public** repo.
GitHub's push protection rejected the push and named the file and line.

**Why my own check missed it.** Before pushing I swept every tracked file for the owner's four
Keychain key values and for `sk-`/`sd_live_`-shaped strings, and it came back clean — correctly.
The credential was not the owner's and did not look like the owner's. **Scanning for your own
keys proves nothing about what a provider handed you.** Any response field that is a URL,
a download link, a callback, or an upload target is a candidate.

**Now.** Redaction lives at the recording boundary in `scripts/spikes/_spike.mjs`, not in each
spike author's judgement:

- a recorded URL loses any query parameter whose name matches
  key/token/secret/signature/sig/credential/password/auth, and **if any matched, the entire
  query string is dropped** — a presigned URL can still authorise on what remains, so removing
  the obvious parameters is not enough;
- key-shaped values (`sk-…`, `sd_live_…`, JWT-shaped) are masked;
- object keys with credential-shaped names are masked whatever their value looks like.

The T2A spike additionally stores only the host and a boolean, never the reference.

**History was rewritten** — `git filter-branch` over all nine commits, `refs/original` deleted,
reflog expired, `gc --prune=now`. Verified by sweeping **every blob in the object store**, not
just reachable commits: zero hits. Nothing had been pushed, so no credential ever reached
GitHub. MiniMax's key was exposed only in a local file and in this session's transcript; the URL
carried an `Expires` parameter, so it is short-lived, and no rotation is owed by the owner.

**The general rule for this repo.** The pre-push sweep checks three things and all three are
necessary: the owner's own key values, credential-shaped strings, and **anything a provider
returned that we chose to persist**. The third is the one that bites, because it does not look
like ours.

**Confirmed-by.** The guard was tested against the exact shape that leaked — a presigned OSS
URL, an `sk-` value, a nested JWT, and a harmless API URL — and redacted the first three while
leaving the fourth intact. GitHub push protection remains the backstop, and it is the only
check in this list that caught the real thing.
