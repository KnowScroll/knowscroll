# Gate 2 worked journey: from an encounter to a personal universe

This is a **proposed journey with illustrative records**, not a recorded user session, generated content, live model output or runtime test. Read alongside [the architecture](02-architecture.md), [contracts](02a-contracts.md) and [harness](02c-harness.md).

Asha opens KnowScroll without onboarding questions. She watches an ML Reel, follows a real continuation, requests a Scroll, briefly asks for football and returns to ML later. The universe gradually reflects those encounters. We follow the same IDs across each loop so there is no unexplained jump from "the algorithm noticed" to "a planet appeared."

## 1. Starting state

- Personal scope: `u_asha`, privacy epoch `7`; recording enabled in this example.
- No recorded personal encounters, planets or inferred preferences.
- Diverse admitted starter inventory already exists. For the example it includes ML, history, football and other topics in both formats. The system must actually commission/admit starter supply before promising this experience at launch.
- `reel_attention_1@3` represents `unit_attention_mechanism`.
- An admitted series `series_attention@1` declares part 1 as that unit and part 2 as `unit_context_disambiguation`, available as `reel_attention_2@1`.
- A Scroll version of part 1 is not yet available. No personal preference is inferred from that supply gap.
- A stable, initially empty scene seed gives the starting environment its appearance. Decorative background stars are distinguishable from semantic topic stars; they are not pre-existing learned topics.

For this example only, use a formation policy with an organising star after two distinct qualified units within a coherent broad topic, and a planet after three distinct qualified units across at least two facets of a subtopic. These numbers are **illustrative, unvalidated choices**, not an approved launch policy. The three-versus-five encounter experiment remains open.

## 2. Opening the dimensional TV

**Asha sees:** a ready Reel, familiar Like/Save/Share controls, a format control and unobtrusive navigation affordances. There is no personality analysis or question to answer.

| Call order | Reads | Stores | Produces |
|---|---|---|---|
| UI → `experience/open` | Authenticated scope and recording policy | Session `session_asha_1`; command receipt | Initial intent revision `1`. |
| API → Composer | Empty ExperienceContext; starter inventory; cold-start policy | `dec_101`, candidate terms and any actual exploration draw probability | Prepared offers for the next 2–3 assets. |
| UI → `experience/activate` | Offer and current publication/access status | Activation for `exp_101`, linked to `dec_101` and `reel_attention_1@3` | Valid exposure token and render/play permission. |
| UI → observation intake | Actual viewport state | `encounter_visible` observation when it occurs | Acknowledged observation; not yet a claim of meaningful consumption. |

The two buffered items not shown to Asha create no encounter evidence. The universe remains empty of semantic topic objects. The client can render dust-like ambient decoration, but it must not represent those unviewed items as explored concepts.

## 3. She watches the attention Reel

Asha watches 42 active, visible seconds of a 50-second explanation. The player sends `evt_101`, matching the [InteractionEnvelope example](02a-contracts.md#2-interactionenvelope--what-the-interface-observed).

1. Intake authenticates and validates the observation. In Kafka-first mode it acknowledges only after durable broker acceptance; in SQL-intake mode it acknowledges after its intake transaction. Both return accepted IDs, separately from projection progress.
2. The normalizer merges intervals and checks the asset revision, exposure, epoch, visibility and instrumentation. It excludes buffering and automatic loops.
3. It stores `ev_101@1`, a qualified encounter with `unit_attention_mechanism`, under a versioned qualification policy. The illustrative consumption contribution is `0.8`; this is a routing feature, not a learning score.
4. The personal projector updates ML/attention activity and the sparse ML×Reel preference entry. It publishes ExperienceContext revision `1` and ExplorationSnapshot revision `1`.
5. A coalesced Planner job may become eligible. Cartographer can consider transient dust, but formation thresholds have not been met.

**Asha sees:** the Reel and whatever she chooses next. She does not see “You learned attention” or “We discovered your interest in ML.”

If she navigates before step 4 finishes, Composer receives current intent plus the bounded provisional observation tail. That can affect the next suggestion immediately; it cannot create permanent evidence or a world.

## 4. Horizontal: real Part 2, not merely another ML video

Asha swipes horizontally on the player. The UI resolves this to `cmd_continue_102`, mode `continue_thread`, current exposure `exp_101`, thread `thread_attention` and expected intent revision `1`.

| Owner | Work and persistent result | Downstream output |
|---|---|---|
| Experience API | Commit the continuation command, advance intent revision to `2`, store receipt and action outbox event. | Immediate navigation response path; no waiting for Planner. |
| Composer | Read the series continuity link and eligibility of `reel_attention_2@1`; record `dec_102`. | Ready offer for declared Part 2. |
| Evidence pipeline | Consume the committed continuation action once; revise `ev_101@1` to `ev_101@2`. | Continuation channel added; projector applies only the difference. |
| Client + intake | Activate and actually display Part 2 as `exp_102`; later send valid playback evidence. | `ev_102@1` for the new unit `unit_context_disambiguation`. |
| Personal projector | Update activity and distinct unit/facet counts. | Context/exploration revision `2` after the relevant evidence is applied. |

Part 2 continues the argument with an example of how context changes a word's meaning. It is a separate explanatory unit with declared continuity, not the first Reel repeated with new visuals.

If an eligible declared sequel did not exist, the response would either offer a clearly described related move or acknowledge a pending sequel request. An explicit “show Part 2” command cannot be fulfilled by a loosely related video. An exhausted thread can end; Asha can leave vertically without a penalty.

## 5. Planner and Cartographer wake from the same evidence

Both see evidence from two actual encounters. Their outputs are deliberately different.

### Planner run `run_plan_101`

The scheduler leases the job and admits a bounded model run. Context bundle `ctx_plan_101` contains `ev_101@2`, `ev_102@1`, the current thread, relevant inventory coverage and no unrelated private history. The harness returns a **hypothetical** plan proposal for validation:

- Offer a limitation of attention as one next continuation.
- Keep an inference/deployment connection as a possible later direction.
- If the relevant inventory is missing, prepare a canonical deployment explanation within the prefetch budget.

The validator stores `plan_101@1`. Composer may consult its opportunities. Quartermaster can receive `demand_prefetch_501` after budget admission. No exposure or interest credit is created by either record.

### Cartographer run `run_cart_202`

A separate context bundle contains the two qualified units, their admitted ML topic relation and the current empty structure. The LLM proposes a coherent ML system and an attention subtopic grouping.

The validator checks the example policy. Two qualified units are enough for the illustrative organising-star rule; three are required for a planet. It accepts only the system/star operations. It stores `delta_202`, moving structure revision `0 → 1`, with references to both evidence records. The planet proposal is retained as pending/insufficient or rejected, according to the proposal lifecycle; it is not applied.

The scene projector chooses the shared ML visual family plus Asha's stable variation seed and publishes `scene_202`, scene revision `1`. A subtle formation animation can show dust gathering into an organising star. There is no attention planet yet.

**The key distinction:** Planner creates possibilities; Cartographer applies evidence-backed geography. Neither run can cite the other's proposal as a new encounter.

## 6. She asks for the same explanation as a Scroll

Asha returns to part 1's parked surface and chooses Scroll. Returning restores its position and original exposure; it is not a new encounter. The format request `cmd_format_201` identifies `unit_attention_mechanism` and `reel_attention_1@3`.

1. The API commits the command, receipt and `demand_scroll_201` in PostgreSQL. A pending response is available immediately. The current Reel remains usable; the app can show a quiet “Preparing Scroll” state.
2. Quartermaster checks for an admitted Scroll variant of the same explanation, not merely another attention article. None exists in this example.
3. It checks compatible open supply. If another user already requested this public variant, it binds Asha's private demand to that job. For this example, none exists, so it admits `supply_301` using the sanitised public brief.
4. Production loads the canonical explanation package, retrieves any needed public sources, writes a coherent article with approved interactive blocks and validates content/rendering. The service records provider attempts and quality outcomes.
5. The Scroll is published as `scroll_attention_1@1`, linked to `unit_attention_mechanism`. Quartermaster marks the demand ready and writes a status notice.
6. The client receives the notice or polls the request. Asha opens the Scroll; Composer/admission records `dec_201`, activation and actual exposure `exp_201`.
7. Reading observations produce `ev_201@1`. The ML×Scroll preference receives evidence. Conceptual variety still contains two distinct units, because this Scroll is part 1's format twin.

The generated article might include a sentence comparison and an interactive attention diagram. It should read naturally and explain the mechanism and its limitations. Research and validation are internal; no model run or source log is shown as a mandatory panel.

If the provider result is uncertain, the job enters reconciliation; the worker does not send another paid generation request merely because the client polls. If the result fails quality checks, it does not become eligible content. Asha sees a truthful unavailable/retry state rather than an invented finished Scroll.

### The Scroll gesture in this moment

Asha scrolls vertically through paragraphs: this emits reading summaries, not vertical feed commands. Dragging a diagram's control stays inside the diagram. A horizontal swipe outside the diagram can continue the thread. At the article's end, leftover scroll momentum stops; a new deliberate gesture or explicit Next control moves to another subject. Going back preserves the article anchor.

## 7. A football detour changes now, not who she is

Asha asks for a football Reel, producing `cmd_topic_301`. The command changes session intent immediately; Composer retrieves eligible football Reels and records `dec_301`. It does not wait for a Planner run and does not let an ML-preferring plan override her request.

A football Reel becomes visible as `exp_301`, but Asha moves away after a brief glance. `ev_301@1` records limited exposure and a weak dismissal, without qualifying for formation under the example policy. Her ML structure remains intact. No football system forms from the command alone.

A pending ML prefetch may be deprioritised if it has not been sent. An already admitted shared job is not destroyed if it serves other valid waiters. Either way, its completion is supply availability, not evidence that Asha returned to ML.

## 8. The next day, the first planet forms

Asha opens the existing ML system. That is an explicit navigation target, not a learning test. Composer uses its topic scope, recent history and `plan_101` if still valid. The limitations continuation is already admitted in this example and opens as `reel_attention_limits@1`, `dec_401`, `exp_401`.

She has a qualified encounter with `unit_attention_limits`, giving `ev_401@1`. The unit adds a third distinct explanation and a limitation facet. The projector advances the exploration snapshot. Cartographer run `run_cart_402` examines the affected ML/attention region; it does not reload every past event from every topic.

| Formation fact | Before | After |
|---|---:|---:|
| Qualified distinct attention explanation units | 2 | 3 |
| Relevant facets | Mechanism, example | Mechanism, example, limitation |
| Voluntary Like presses required | 0 | 0 |
| ML organising star | Present | Present |
| Attention planet | Not yet formed | Eligible under the illustrative three-unit rule |

The deterministic applier accepts `delta_402`: `form_planet planet_attention`, parent `system_ml`, plus supported region descriptors. It commits structure revision `1 → 2` and the outbox event atomically. Only then does the scene projector publish `scene_402`, scene revision `2`.

**Asha sees:** matter gathers into a planet around her ML star. Entering it reveals regions corresponding to the mechanism, contextual examples and limitations she has encountered. Their sizes and terrain are a designed visual expression, not a calibrated measure of understanding. No message announces that she made a connection or mastered a subject.

If the scene worker is delayed, the semantic planet exists while the last scene remains visible. The next valid manifest catches up. Replaying the scene notification cannot create a second planet.

## 9. Over the week, supply and exploration influence each other

The earlier `demand_prefetch_501` may now have produced an admitted deployment explanation. Composer can offer it when relevant, but it has added no personal evidence yet.

Suppose Asha subsequently has qualified encounters with three different inference-related units: serving a model (`exp_501`), batching tradeoffs (`exp_502`) and latency/cost constraints (`exp_503`). Each has its own real observations and evidence record. Only then can Cartographer consider an inference planet under ML with appropriate regions and a supported route from attention.

This illustrates the useful feedback loop:

`actual encounters → possible content opportunity → bounded supply work → eligible asset → chosen offer → actual encounter → possible structural change`

The two middle stages cannot skip the actual encounter. If she never opens the deployment explanation, it remains unused inventory; her universe does not acquire an inference planet.

The Planner can be wrong cheaply. An unused plan expires. Quartermaster's global reuse means another person may still find the canonical explanation useful. Production success, selection rate and encounter response are measured separately, so inventory availability does not become a fabricated personal interest signal.

## 10. Later: a room between ML and backend

This step belongs to the proposed later social capability. It is not a launch claim. Assume Asha has also genuinely explored backend through separate qualified encounters in queueing, caching and service reliability; no backend system is created just because a model suggested one.

A shared room `room_model_serving` discusses running models in backend systems. It has a canonical identity, membership rules and message history independent of Asha's scene. Her private placement points from the inference planet toward a backend system. Another person's same room may appear between distributed systems and applied AI.

| Action / owner | Stores | Does not imply |
|---|---|---|
| Asha enters an authorised room | Membership/access receipt and room visit under its policy | She read all messages or agrees with the room. |
| A human posts an explanation | Attributed room message | Personal qualified Reel/Scroll evidence for every member. |
| Moderator organises a thread | Moderation action or summary with provenance | A new human participant or consensus. |
| Labelled AI inhabitant explores a counterexample | AI-attributed message under a bounded participation budget | Genuine human activity or Asha's belief. |
| Asha requests a Scroll from the discussion | Private ContentDemand with authorised room material scope | Public permission to reuse private room messages. |
| Asha opens the admitted resulting Scroll | New actual encounter and subsequent evidence | Automatic credit from the room's existence. |

Only Reels and Scrolls are consumption objects. Room posts remain conversation; a useful discussion can be turned into a separately admitted Reel/Scroll when requested. Optional polls or quizzes inside an explicitly entered room are room activities, never compulsory feed tests or formation prerequisites.

A friend visiting Asha's universe sees only objects she deliberately shared. The visitor manifest omits private evidence, hidden regions and internal interest scores. Revoking access invalidates future fetches and managed caches; it cannot claw back a screenshot someone already made. Sharing is not permission to merge two private histories.

## 11. Time away, return and privacy

### Time away

Asha leaves for a month. Activity decays, particles calm and the initial camera may emphasise other recent worlds. The ML star and planets remain. There is no destruction, debt or missed reward. A return can create a new encounter if she deliberately opens content afresh; simply loading the existing scene is not content-consumption evidence.

### Privacy race

Suppose a Planner run based on epoch `7` is in flight when Asha uses a privacy control that advances the epoch to `8`.

1. The privacy command takes the universe lock first, rechecks session/epoch and commits its idempotent receipt and scoped erasure/invalidation work.
2. Queued jobs, contexts, caches and private artifacts in the control's scope are invalidated or erased. Transport payloads follow the selected and explicitly promised deletion design.
3. The old run may still finish remotely. Its result cannot apply: the applier's fresh epoch check rejects it. No stale plan, demand or planet returns.
4. A queued client observation from epoch `7` is rejected for personal projection. Rebuilding state uses only surviving permitted evidence.
5. Shared public explanation assets remain where the privacy contract permits; Asha's waiter binding and private context are removed within scope.

Clear-history, universe reset and account deletion must retain their distinct declared scopes. This example shows epoch fencing and scoped deletion; it does not silently extend today's clear-history promise to every backup or external provider.

## 12. The complete lineage in one place

| Record | Produced by | Causal input | What it can cause next |
|---|---|---|---|
| `dec_101` | Composer | Initial context + eligible inventory | Prepared offer, then possible activation. |
| `exp_101` | Admission + visibility observation | Activated offer actually displayed | Valid observations can become evidence. |
| `ev_101@1`, then `@2` | Evidence pipeline | Playback, then committed continuation | Context changes and scoped background work. |
| `ev_102@1` | Evidence pipeline | Actual Part 2 encounter | A second distinct explanatory unit. |
| `plan_101@1` | Planner validator | Qualified evidence snapshot | Opportunities and admitted demands only. |
| `delta_202` | Cartographer applier | Two qualified units + example star policy | ML system/star, structure revision 1. |
| `scene_202` | Scene projector | Applied structure and stable visual seed | Renderable organising star. |
| `demand_scroll_201` | Request admission / Quartermaster | Explicit same-explanation format command | Reuse, join or supply admission. |
| `supply_301` | Quartermaster | Sanitised brief + budget | Production attempts, validated content. |
| `scroll_attention_1@1` | Publication gate | Checked article and evidence package | Candidate availability only. |
| `exp_201`, `ev_201@1` | Admission / evidence pipeline | Actual Scroll opening and reading | Format evidence; no extra distinct unit for its Reel twin. |
| `exp_301`, `ev_301@1` | Admission / evidence pipeline | Brief football detour | Immediate routing evidence; no football formation here. |
| `exp_401`, `ev_401@1` | Admission / evidence pipeline | Actual limitations encounter | Third qualified unit, eligible formation input. |
| `delta_402` | Cartographer applier | Validated proposal + three distinct units | Attention planet, structure revision 2. |
| `scene_402` | Scene projector | Applied delta | Planet appearance and navigable regions. |

## 13. What this journey deliberately leaves for review

- Whether three or five distinct qualified encounters feels appropriate, and the separate star/protostar policy.
- Whether a fresh vertical gesture at a Scroll boundary feels natural on real devices; explicit controls remain available.
- Whether the shared ML visual family is recognisable while each person's world feels individual.
- Whether the content itself is engaging, coherent and accurate enough to justify continued exploration.
- Whether Kafka-first can meet the chosen privacy guarantee; otherwise use the documented SQL-intake fallback.
- Whether Pi's adapter reduces actual implementation work while retaining admission and privacy behavior.

These uncertainties do not leave the loop connections undefined. They identify the policy, interaction and infrastructure choices that should be challenged before program design and implementation.
