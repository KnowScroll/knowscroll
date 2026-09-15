> Adopted product definition. Product laws and full scope remain current. Historical implementation sequencing, provider names and architecture links below are governed by [ADR-0008](../decisions/ADR-0008-foundation-adoption.md) and the [current architecture](../architecture/README.md). This is not a claim that the product is implemented.

---
status: current
authority: product-vision
note: read-only. The product promise, the 17 laws, the cosmic grammar. Deviations become DECISIONS entries citing the section.
---

# KnowScroll: Canonical Product and UX Definition

> Status: product direction locked for implementation planning, September 2026
>
> Authority: this file owns the product promise, product laws, vocabulary, interaction grammar, user journeys, and phase outcomes. `ARCHITECTURE.md` owns the intended system. `RESEARCH.md` owns evidence, risks, and open hypotheses.

## The product in one sentence

**KnowScroll is an emergent personal universe that turns the impulse to scroll into encounters that gradually expand what a person knows, notices, and believes is possible.**

The simplest promise is:

> **Come here when you want to scroll. Leave with a slightly larger world.**

The defining product law is:

> **The universe is not authored by the user. The user authors it indirectly by living inside it.**

KnowScroll observes how a person explores, forms uncertain hypotheses about the edge of their current world, researches what may lie beyond it, and changes the universe around their journey. The person does not maintain an interest profile, arrange planets, choose a curriculum, or approve every inference. They watch, read, ask, skip, argue, predict, create, share, and wander. Their universe emerges from that life.

This is not the same as saying that nobody controls the system. Developers still choose and audit its objective, evidence rules, safety constraints, data retention, and generation boundaries. The honest formulation is:

> **We build and govern the physics. We do not hand-author the planets.**

The outcome is emergent. The laws remain accountable.

---

## Core philosophy: know yourself by the Scroll

Attention-harvesting feeds do more than consume time. Repeated exposure changes
what feels important, normal, desirable, frightening, or possible. The person is
quietly building a model of the world and of themselves, but the system shaping
that model is usually optimizing for continued attention rather than clarity,
range, or agency.

KnowScroll uses the familiar act of scrolling to reverse that relationship.
Every Reel or Scroll should work as both:

- a **window** onto a person, idea, domain, argument, or possibility outside the
  person's current assumptions; and
- a **mirror** that helps them notice what attracts them, what they resist, what
  they assume, where they contradict themselves, and what changes their mind.

This is what **know yourself by the Scroll** means. It is not a personality quiz,
a quantified-self dashboard, a hidden diagnosis, or an AI declaring who the
person really is. The system creates evidence-rich encounters through which the
person can discover themselves indirectly by predicting, choosing, comparing,
questioning, making, revisiting, and sometimes changing their mind.

A better mental model is not simply a larger collection of facts. It is more
connected, better calibrated, more capable of holding uncertainty, more exposed
to serious alternatives, and easier to revise when reality disagrees.

The desired loop is:

```text
encounter → notice → question → test → revise → carry forward
```

The product therefore has two inseparable outcomes:

1. **Know more of the world.** Encounter valuable things the person would not
   have thought to search for.
2. **Know more of yourself.** Notice the assumptions, curiosities, blind spots,
   explanation styles, contradictions, and changes of mind revealed by the
   journey.

Every major product decision must preserve both outcomes. If KnowScroll merely
replaces brain rot with more sophisticated passive consumption, it has failed.

---

## 1. Why this should exist

The product begins with an ordinary moment:

> I have a few minutes. Show me something interesting.

Today that moment often becomes Instagram, X, Reddit, YouTube, or another infinite feed. The experience is effortless, but thirty minutes later very little remains. KnowScroll should satisfy the same impulse without pretending that the person opened an educational app, began a course, or agreed to study.

A useful session might begin with a twenty-second reel about a strange historical decision. The person swipes sideways to see the counterfactual, reads an interactive Scroll, commits to a prediction, argues with an inhabitant of a School of Thought, and enters a world they did not know existed. They leave because life continues.

Nothing felt like homework. Yet their mental world is no longer exactly the same.

Over months, this change becomes visible:

- a distant subject becomes a planet;
- a foundational idea becomes a star;
- an unresolved contradiction gains the gravity of a black hole;
- two separate interests form a moon or bridge;
- a belief collapses and leaves a ruin;
- a question creates an entire frontier;
- a friend's universe exposes a continent they had never thought to search for.

KnowScroll is not trying to make the person finish content. It is trying to make their world harder to keep small.

---

## 2. The final idea

KnowScroll has three inseparable layers.

### 2.1 The universe

The universe is the primary interface and the visible expression of the system's current, uncertain understanding of the person.

It is not a folder hierarchy, a skill tree, or a manually arranged knowledge graph. It is living geography. The person can pan, zoom, approach, enter, and return. The surface is spatial because spatial change makes intellectual change felt rather than merely reported.

The universe is personal, but it is not solipsistic. Worlds are grounded in a shared epistemic substrate of sources, claims, concepts, people, events, and relationships. Two users may have very different versions of Programming, but the system can still understand that both regions refer to compilers, consensus, or graphics and can build a meaningful bridge between them.

### 2.2 The World Engine

A persistent agent harness runs the system:

```text
observe → infer → research → simulate → create → expose → observe again
```

It does not reduce the person to a list of interests. It maintains competing, revisable hypotheses about:

- what they already understand and at what depth;
- what they have seen but may not understand;
- which explanations help them continue;
- which assumptions recur in their reasoning;
- which ideas and people have influenced their paths;
- where their stated views and behavior conflict;
- which perspectives are missing from their universe;
- which subjects are adjacent but still invisible;
- which questions are beginning to emerge;
- where repeated recommendations may themselves be shaping behavior.

The Engine then researches credible material, creates encounters, evolves worlds, and exposes the person to a mixture of familiarity, productive surprise, opposition, and frontier.

The Engine must never treat a psychological guess as a hidden diagnosis or personal truth. Its personal model is a private set of evidence-linked hypotheses with confidence, counterevidence, and decay. It uses those hypotheses to stage encounters, not to declare who the person is.

### 2.3 Two things to consume

Despite the complexity underneath, the person primarily consumes only two objects:

1. **Reels** — short generative audiovisual encounters.
2. **Scrolls** — interactive documents that can contain prose, media, code, simulations, maps, games, and conversations.

Both use the same navigation grammar:

```text
vertical movement   = show me a different discovery
horizontal movement = continue, deepen, vary, or oppose this discovery
enter world         = leave the stream and visit the place behind it
```

The universe supplies orientation. Reels and Scrolls supply immediacy. The World Engine supplies continuity.

---

## 3. Product laws

These are implementation constraints, not marketing language.

### Law 1: The universe emerges from lived behavior

The person does not configure interests, arrange celestial objects, maintain a profile, approve ordinary inferences, or choose a curriculum. Their actions are the input. The changing universe is the output.

### Law 2: The physics are governed even when the outcome is not authored

Developers define objectives, candidate sources, ranking constraints, privacy limits, safety policy, provenance requirements, cost budgets, and evaluation. The World Engine may decide what emerges within those laws. It may not silently rewrite the laws.

### Law 3: Engagement is a constraint, not the objective

The next encounter must be interesting enough to continue, but predicted engagement alone must never determine it. The Engine optimizes for useful expansion under an interest threshold: connected surprise, perspective diversity, credible depth, uncertainty reduction, and long-horizon return.

### Law 4: Behavior is evidence, never proof

Watching does not prove agreement. Finishing does not prove understanding. Replaying may indicate confusion rather than love. Skipping may mean boredom, bad timing, repetition, or a poor explanation. Every inference remains a hypothesis.

### Law 5: The system remembers that it caused the exposure

Recommendations change future behavior. If the Engine repeatedly shows compilers and the person watches compilers, that is not clean evidence of an intrinsic preference. Every observation must retain the exposure that preceded it. The Engine must test alternatives, preserve counterevidence, and avoid self-confirming worlds.

### Law 6: The universe is meaningful, not decorative

Every visible celestial change maps to a typed semantic change with lineage. A star cannot appear merely because an animation looked beautiful. A black hole cannot be a generic difficulty badge. The visual language is the product's model language.

### Law 7: Infinite supply does not justify empty repetition

Interdimensional streams may continue indefinitely, but the system must use a bounded rolling window, detect redundancy and fatigue, and avoid generating filler to preserve motion. “Infinite” means that a meaningful next path can be created, not that every swipe deserves synthetic content.

### Law 8: Generated media is a branch, not a dead asset

A Reel or Scroll can continue, change explanation, expose an opposing view, create an example, become a series, or open its world. Every generated artifact retains its source, prompt, model, seed when available, truth state, and branch lineage.

### Law 9: Truth state travels with the encounter

Documented fact, source-backed synthesis, interpretation, disputed claim, modelled outcome, and fiction must look different. A compelling presentation cannot upgrade a weak claim.

### Law 10: Agents are inhabitants, not authorities

Agents can research, argue, synthesize, search for counterexamples, form factions, and change positions. They may make worlds feel alive even while the person is away. Their statements still require sources or explicit uncertainty. Agent consensus is not truth.

### Law 11: No hidden psychological dossier

The system may infer subject familiarity, explanation response, recurring questions, and intellectual adjacency. It must not silently diagnose mental health, attachment, trauma, sexuality, political identity, protected traits, secret fears, or similar high-risk characteristics and use them to shape the world.

### Law 12: Safety controls are not authorship controls

The person does not edit planets or tune ranking weights. They can still pause personalization, clear or delete history, reset their personal universe, report a wrong or harmful inference, mute a subject or person, export their data, and control social visibility. These controls protect agency and privacy; they do not turn the universe into a settings form.

### Law 13: The system must explain outcomes without exposing a profile editor

“Why this appeared?” should show the immediate path: the branch, question, friend, source, or unexplored connection that led here. It must not show reductive percentages such as “72% interested in programming.”

### Law 14: Orientation survives every transition

Moving from universe to Reel, Scroll, a simulation embedded in a Scroll, Idea Room, friend visit, or world never feels like opening an unrelated application. The origin remains visually and semantically available, and return restores the previous place and direction.

### Law 15: Social contact expands worlds; it does not expose private inference

Friends may visit shared projections, compare regions, enter rooms, share branches, and blend selected geography. They never receive the other person's inference ledger, raw behavioral history, private questions, or hidden world state.

### Law 16: No obligation mechanics

No streaks, punishment, countdown pressure, guilt copy, or notification spam. The product may be infinite, but it must not manufacture obligation.

### Law 17: Every encounter serves a better mental model

A Reel or Scroll should create at least one meaningful opportunity to encounter,
connect, compare, predict, manipulate, question, or revise. Completion and recall
are not required, and the system must not claim that a person learned something
because they watched it. But an encounter selected only because it is likely to
hold attention violates the product even when its subject appears intellectual.

---

## 4. The cosmic grammar

Cosmic objects are a compact language for the personal world model.

| Object | Semantic meaning | Typical cause | Primary action |
|---|---|---|---|
| **Universe** | the person's evolving intellectual possibility space | all accumulated encounters and world evolution | orient, wander, enter |
| **World / Planet** | a substantial domain with its own geography and inhabitants | sustained, coherent domain emergence | approach, enter, explore |
| **Star** | a foundational concept or system that illuminates many regions | several ideas become explainable through one foundation | orbit, learn, trace influence |
| **Moon** | an intersection or dependent subworld between larger domains | a useful connection repeatedly appears | cross, compare, blend |
| **Constellation** | a relationship among separated ideas or worlds | evidence supports a cross-domain pattern | inspect relation, follow path |
| **Black Hole** | a high-gravity unresolved question, contradiction, or depth frontier | repeated branches converge without resolution | approach, test, debate |
| **Supernova** | a rare transformation that reorganizes existing understanding | evidence, argument, or creation changes several regions at once | witness, inspect before/after |
| **Dark Frontier** | a credible adjacent region not yet understood | Engine discovers valuable but unbridged territory | probe, request a path |
| **Rift** | a counterfactual or simulated branch | one premise or parameter changes | predict, manipulate, compare |
| **School of Thought** | a situated tradition or family of arguments | a coherent intellectual lineage matters to the world | enter, speak, disagree |
| **Idea Room** | a live place where humans and agents develop a question | a question needs collective reasoning | converse, make, preserve |
| **Station** | a recurring social or event location | a community or practice sustains activity | visit, join, return |
| **Ruin** | a superseded belief, failed model, or historically abandoned path | later evidence or argument changes the landscape | inspect what changed |
| **Relic** | a durable object deliberately kept or made by a person | save, prediction, creation, synthesis | revisit, cite, share |
| **Trace** | a lightweight mark of passage | a question, reaction, prediction, or branch | remember, revisit |

### 4.1 Emergence rules

A new object requires:

- a semantic type;
- an evidence or interaction lineage;
- a reason it belongs here rather than elsewhere;
- confidence and uncertainty;
- a visual consequence;
- an expiry, decay, or revision rule where appropriate.

The Engine may materialize a planet without asking permission. It may not materialize an unexplained planet.

### 4.2 Recursive worlds

Every world runs the same loop at a smaller scale.

The Programming world observes which regions the person visits, which explanations work, what they build, what they skip, and which questions become gravitational. It may grow a Compilers continent, keep Frontend as a distant island, connect AI Systems to Language Theory, or reveal a Dark Frontier beyond JIT compilation.

Two processes therefore happen at once:

> **The person's activity changes the universe.**
>
> **The person's activity changes each world inside the universe.**

### 4.3 Shared substrate, private geography

The meaning underneath worlds is shared; the experienced geography is personal.

This is what lets a friend say, “You have an entire continent here that barely exists in my world,” without turning each universe into an incompatible hallucination. The two universes can compare the same semantic anchors while preserving different paths, prominence, inhabitants, and history.

---

## 5. The World Engine

The World Engine is not one endless model process. It is a persistent system made of event logs, typed state, research jobs, models, tools, policy, evaluation, and bounded agent runs.

### 5.1 What it observes

The Engine may observe product interactions that are necessary for the experience:

- impression and source of exposure;
- immediate skip;
- active watch or read time;
- completion and abandonment point;
- replay and reread;
- vertical discovery swipe;
- horizontal branch continuation;
- alternative, example, opposition, or depth request;
- save as Relic;
- prediction or decision;
- explicit question;
- agreement, disagreement, and counterargument;
- world entry, route, and return;
- agent and human conversation;
- share, co-voyage, friend visit, and Blend;
- later revisit or use.

It should not collect unrelated device behavior, cross-app surveillance, private message contents beyond explicitly participating KnowScroll spaces, or data merely because it might improve ranking.

### 5.2 What it infers

Inference is divided into three levels.

#### Observed state

Directly recorded facts: the person saw item X, branched to Y, made prediction Z, or entered a world.

#### Behavioral hypotheses

Revisable interpretations: they may understand this concept, this explanation style may help, this contradiction may matter, or this frontier may be productively adjacent.

#### Prohibited hidden character judgments

Clinical, intimate, protected, or manipulative labels are outside the World Engine's personalization authority. The product does not need to decide that someone is insecure, addicted, depressed, conservative, autistic, traumatized, or secretly ambitious in order to expose them to high-value ideas.

### 5.3 How it researches

The Engine retrieves rather than pretending omniscience. A research job can:

1. formulate an explicit knowledge gap;
2. search primary sources and credible secondary explanation;
3. extract claims and disagreements;
4. record provenance and retrieval time;
5. identify uncertainty and missing perspectives;
6. construct candidate Reels or Scrolls, plus destination or world changes;
7. pass them through truth, rights, safety, and quality gates;
8. serve or materialize eligible results;
9. measure what happened without treating the result as a clean preference label.

The model is a researcher and synthesizer. The source record remains the evidence.

### 5.4 How it decides what appears next

The next encounter is selected from several candidate families:

- continuation of the current branch;
- familiar but unfinished territory;
- a bridge from the familiar to the frontier;
- an opposing school or counterexample;
- a friend's selected discovery;
- a timely event connected to an existing world;
- a randomly sampled frontier probe;
- a world event generated by inhabitants;
- a previously encountered idea that has become newly relevant.

Ranking predicts multiple actions rather than a single “engagement” probability. It then combines those predictions with expansion value, source quality, diversity, fatigue, and epistemic risk. A diversity stage reranks the result so one successful subject cannot consume the entire sky.

### 5.5 How worlds change while the person is away

Bounded world ticks can run without the person present.

A School of Thought may debate a question. An evidence-seeking agent may find a counterexample. A synthesis agent may discover that two discussions share a hidden premise. The Engine may materialize a new path, revise a region, or create an event for the next visit.

Every autonomous change must have:

- a run budget and deadline;
- allowed tools and source policy;
- an explicit output schema;
- a quality or invariant gate;
- a traceable receipt;
- a risk tier that determines whether it can appear automatically;
- a rollback or supersession path.

Autonomy creates activity. It does not remove accountability.

### 5.6 How a branch remains continuous

Every horizontal continuation carries a **Continuity Capsule**. It is the
smallest sufficient state needed to continue the thought without reconstructing
the whole journey:

- the question or idea currently being explored;
- source claims, truth state, assumptions, and unresolved disagreements;
- the branch lineage and recent explanations already shown;
- the current world and map origin;
- the last meaningful visual frame for a Reel;
- interactive state, predictions, and completed blocks for a Scroll;
- any Relics deliberately carried into the branch;
- visual, character, and camera grammar where continuity requires them.

The Capsule is not the person's profile and is not an ever-growing prompt. It is
a versioned, inspectable handoff between one encounter and its continuation.

### 5.7 Preparation happens during attention

While the person watches a Reel or reads a Scroll, the system may prepare likely
continuations. This is **Speculative Branch Preparation**.

Preparation is graduated:

1. retrieve and rank existing sourced continuations;
2. prepare cheap branch plans for deeper, opposing, example, and
   counterfactual paths;
3. generate expensive media only for the most likely or explicitly requested
   path within a budget.

The product must not generate several expensive videos after every swipe merely
to simulate instant response. Prepared but unseen branches are not behavioral
evidence about the person.

### 5.8 Generated output is reconciled before it becomes an encounter

For generated Reels, a **Visual Witness** describes what the resulting frames
actually show without being told what the prompt intended. An **Encounter
Reconciler** then compares that observation with the Continuity Capsule, source
claims, truth state, safety rules, and intended explanation.

The result is accepted, relabelled, regenerated, or rejected.

In a fictional or counterfactual branch, the rendered result may establish what
happened inside that imagined experience. In factual material, the visual never
overrules the sources. A generation error changes the asset, not reality.

---

## 6. The two consumption objects

### 6.1 Reel

A Reel is a short audiovisual encounter that begins immediately and remains branchable.

It may be:

- a visual explanation;
- a historical scene;
- a character-led argument;
- a counterfactual moment;
- a demonstration;
- a source excerpt with interpretation;
- a world event;
- one episode in an evolving series.

#### Reel actions

Vertical swipe means **another discovery**.

Horizontal swipe means **continue this discovery**. The continuation may be:

- next episode;
- deeper mechanism;
- alternative explanation;
- concrete example;
- opposing perspective;
- consequence;
- character branch;
- counterfactual branch.

Persistent actions remain minimal:

- source / truth state;
- save Relic;
- discuss or share;
- enter world;
- more / less / report;

The person can explicitly ask for another branch. H3-style video generation runs behind a job boundary; the UI never implies that generation is instant, free, or guaranteed.

### 6.2 Scroll

A Scroll is an explorable idea presented as an interactive document.

It is not merely an article in a space-themed reader. It can contain:

- beautiful long- or short-form prose;
- images and image sequences;
- animation and scrollytelling;
- interactive diagrams;
- executable code in a sandbox;
- causal simulations;
- small games;
- timelines;
- maps and world fragments;
- polls, choices, and predictions;
- agent conversations;
- manipulable data;
- citations and competing interpretations.

A Scroll can be twenty seconds or twenty minutes. Duration does not define it. Coherent exploration does.

#### Scroll navigation

Vertical movement first belongs to reading the current Scroll. Reaching the end reveals the next-discovery threshold; one deliberate continuation moves to the next Scroll.

Horizontal movement requests another branch when the current embedded object is not using the gesture. A visible branch rail and keyboard controls prevent hidden gesture-only navigation.

An embedded game, code editor, map, or slider temporarily owns its interaction region. It must never accidentally throw the reader out of the Scroll.

### 6.3 Relic is not Scroll

Earlier versions used “Scroll” for a saved artifact. That terminology is retired.

- **Scroll** is one of the two primary consumption objects.
- **Relic** is durable, portable, executable context.
- **Trace** is a lightweight mark of passage.

A Relic may carry a concept, claim and source set, prediction, simulation state,
visual fragment, or created argument into another branch, world, Scroll, Rift,
Idea Room, or Blend. “Executable” does not mean arbitrary code. It means the
World Engine can use the typed, permissioned contents as input to a later
research, generation, comparison, or simulation action.

A Relic always retains provenance, truth state, ownership, visibility, version,
and correction dependencies. Carrying a Relic into a shared space is explicit;
private Relics never leak through automatic generation.

### 6.4 There are no other consumption formats

This distinction is canonical across product, UX, and architecture:

```ts
type ConsumptionObject = Reel | Scroll;
```

Everything else is either a place, a relationship, an interaction embedded
inside a Scroll, or a semantic role played by a Reel or Scroll.

| Earlier label | Canonical treatment now |
|---|---|
| **Theatre** | optional world landmark containing Reels; not a format |
| **Library** | optional world landmark containing Scrolls; not a reader type |
| **Field Note** | a compact Scroll block, Trace, or Relic |
| **Workshop** | an interactive Scroll composition or a place containing one |
| **Arena** | a decision, prediction, or mini-game embedded in a Scroll |
| **Rift** | a counterfactual place or branch expressed through Reels and Scrolls |
| **School** | a place and agent/social context; its feed appearances are Reels or Scrolls |
| **Idea Room** | a destination for deliberation; its preserved output is a Scroll or Relic |
| **Station** | a social place; its discoveries enter streams as Reels or Scrolls |
| **Mission** | an external-action prompt or sequence embedded in a Scroll |

These names may remain in the universe's geography when semantically useful.
They must never create a third feed card, stage renderer, gesture grammar, or
top-level content type.

---

## 7. Interdimensional streams

### 7.1 Interdimensional Cable

The Cable is the zero-effort replacement for opening a conventional social feed.

It is an infinite mixture of Reels and Scrolls drawn from the person's known universe, its frontier, selected social connections, and live world events.

The Cable starts immediately. It does not require choosing a world. Each item still has a visible origin, and Enter World turns consumption into situated exploration.

### 7.2 Interdimensional Scroll

The Interdimensional Scroll is a Scroll-only stream for moments when the person wants text, interaction, and depth without audiovisual Reels.

It uses the same discovery and branch grammar as Cable. It is not a separate recommendation system.

### 7.3 Infinite does not mean pre-generated

The client receives a bounded rolling window and a continuation cursor. The Engine keeps supplying eligible encounters as the person moves. Expensive branches are generated on demand or prepared ahead of time based on credible paths.

The stream must never fabricate low-quality filler to hide generation latency. It can return to sourced material, surface a different frontier, or say that a requested branch is being prepared.

### 7.4 The deliberate ethical tension

Infinite feeds remove stopping cues. KnowScroll is intentionally accepting that interaction because the personal use case begins with replacing doomscrolling, not constructing a course.

That decision is not a claim that infinite scrolling becomes harmless when the content is intellectual. The product must measure whether it actually substitutes for lower-value scrolling, whether sessions leave useful residue, whether diversity remains healthy, and whether the person retains agency. If those outcomes fail, the interaction must change.

No streaks, urgency, guilt, autoplay notifications, or manufactured social pressure may compound the infinite surface.

---

## 8. Primary surfaces

### 8.1 Home / Universe

Opening the app presents the living universe, not a dashboard.

The surface contains:

- the current personal universe;
- recent changes as quiet celestial events;
- an immediate Cable entry;
- an immediate Scroll entry;
- friend and room activity as distant signals;
- search / Ask;
- a small compass for return, privacy, and account controls.

The universe should be an infinite semantic canvas. Zooming does not merely enlarge graphics; it reveals systems, worlds, regions, rooms, and encounters at meaningful levels.

### 8.2 World

Approaching a planet preserves the original universe position while local detail resolves. Entering reveals:

- geography shaped by this person's history;
- active schools and inhabitants;
- Reels and Scrolls situated in regions;
- Rifts, simulations, ruins, and frontiers;
- world-specific Cable and Scroll streams;
- live events and social presence;
- a clear route home.

### 8.3 Idea Room

An Idea Room is a place, not a chat tab.

It contains:

- a shared question or object;
- humans, agents, and represented schools;
- sources and evidence objects;
- predictions and decisions;
- branchable arguments;
- Relics created by the room;
- a visible lineage from conversation to any world change.

Direct messages can emerge as private routes or small private rooms connected to a shared origin. The product should not reproduce a generic inbox before social use proves that need.

### 8.4 Friend universe

A friend visit is a visit to an authorized projection, not access to their hidden model.

The visitor can:

- see selected worlds and prominence;
- follow published or shared traces;
- experience selected Cable paths;
- enter shared rooms;
- propose a co-voyage;
- create a temporary Blend.

The visitor cannot inspect raw event history, private inferences, invisible worlds, or personal conversations.

### 8.5 Rest state

A Home Moon or quiet orbit provides a non-feed state:

- review saved Relics;
- see what changed in plain language;
- revisit questions and predictions;
- control privacy and data;
- leave the product.

It is a place to return, not a productivity dashboard.

---

## 9. Transition grammar

The hardest UX problem is not drawing the universe or polishing the Reel player. It is making the transition between them feel like one product.

### 9.1 The universal sequence

```text
ORIENT → APPROACH → CROSS THRESHOLD → EXPERIENCE → LEAVE TRACE → RETURN
```

#### Orient

The person knows where they are, what object is near, and where it came from.

#### Approach

The chosen object gains detail. The surrounding universe remains present long enough to preserve scale and direction.

#### Cross threshold

The camera, audio, color, typography, and controls transform into the destination. The product does not cut from fantasy map to a generic white reader or black Reel clone.

#### Experience

The destination uses its native interaction: watching, reading, manipulating, talking, predicting, or playing.

#### Leave trace

The experience may leave a branch, prediction, Relic, relationship, or world change. No completion badge is required.

#### Return

Back reverses the spatial transition and restores the prior viewport, selected object, and route.

### 9.2 Map to Reel

1. Tap a Reel marker or moving visual encounter in a world.
2. The map continues underneath while the object expands.
3. Local geography becomes the Reel's edge texture and origin label.
4. The Reel reaches full stage; vertical discovery and horizontal branching become active.
5. Enter World collapses the Reel toward its source region.
6. Back restores the exact map position or stream item.

### 9.3 Map to Scroll

1. Select a Scroll marker, world library landmark, ruin, or question.
2. The route becomes a reading spine.
3. Nearby world fragments move into the document margin.
4. Interactive blocks inherit the region's visual vocabulary.
5. Sources remain attached to claims rather than hidden at the end.
6. Return folds the Scroll back into its place.

### 9.4 Stream to world

Every Reel and Scroll exposes its world origin. Entering never launches a generic detail page. The current encounter becomes a physical landmark in the destination, so the person understands where the idea lives and what surrounds it.

### 9.5 Desktop and mobile

Mobile is not a compressed desktop universe. Desktop is not a stretched phone feed.

#### Mobile

- one-thumb Cable entry;
- vertical full-height Reel stages;
- full-width Scroll reading with protected embedded controls;
- drag and pinch universe canvas;
- bottom compass with Home, Cable, Scroll, Ask, and Friends;
- sheets only for sources, controls, and compact branches.

#### Desktop

- pointer and keyboard universe navigation;
- centered stage with origin context visible around it;
- optional branch rail and source rail;
- split view only when comparing a simulation, source, or friend world;
- arrow keys and accessible buttons mirror gestures;
- no permanent dashboard chrome covering the universe.

---

## 10. Core user journeys

### Journey A: Replace a doomscroll reflex

```text
Open app
→ Universe appears immediately
→ tap Cable
→ watch a Reel
→ swipe vertically twice
→ encounter a Scroll
→ make one prediction
→ leave
```

Success is not session length. Success is that the interaction was effortless and one useful trace remains.

### Journey B: Fall down a good rabbit hole

```text
Cable Reel: “Why Rome could not price political risk”
→ horizontal: mechanism
→ horizontal: modern counterexample
→ Scroll: playable coordination game
→ disagree with the explanation
→ enter Political Economy world
→ black hole appears around an unresolved premise
→ save a Relic
```

### Journey C: Generate a continuing series

```text
Watch historical counterfactual Reel
→ ask “what if Germany never invaded the Soviet Union?”
→ choose documented assumptions
→ generation job prepares episode
→ watch clearly labelled counterfactual Reel
→ horizontal: alternative model
→ enter Rift
→ compare assumptions and sources
```

The product never presents generated narrative as historical fact.

### Journey D: Discover an emerging world

```text
Several encounters connect compilers, logic, and language
→ World Engine researches the bridge
→ a distant moon becomes visible
→ next visit shows a quiet world event
→ approach moon
→ read why it emerged
→ explore without configuring it
```

### Journey E: A world changes while away

```text
Leave an Idea Room after making a prediction
→ bounded agents continue evidence search and debate
→ verifier rejects one unsupported claim
→ a counterexample survives quality gates
→ World Engine creates a new route and revises a region
→ next visit: “A path changed while you were away”
→ inspect source-backed Chronicle
```

### Journey F: Visit a friend's universe

```text
Friend shares a world projection
→ enter their Programming planet
→ notice a continent absent from your version
→ follow one selected path
→ invite friend to a temporary Blend
→ shared Idea Room opens at the intersection
→ both personal universes may later evolve differently
```

### Journey G: Correct the system without authoring it

```text
Encounter feels based on a harmful or plainly wrong inference
→ open Why this appeared?
→ see the immediate evidence path
→ choose Wrong connection, Less like this, or Report
→ Engine records counterevidence and suppresses the causal route
→ no profile editor or planet deletion workflow appears
```

### Journey H: Discover something about yourself

```text
Commit to a prediction inside a Scroll
→ later encounter credible evidence that challenges it
→ revise the prediction and carry the unresolved question as a Relic
→ a later world connects that question to a recurring assumption
→ Chronicle shows the path and evidence without declaring a personality trait
→ recognize “I tend to reason about this differently now”
```

The insight belongs to the person. The system stages and preserves the journey;
it does not announce a hidden truth about who they are.

### Journey I: Reset or leave

```text
Open compass
→ pause personalization, export data, clear history, or reset universe
→ system explains consequence plainly
→ destructive choice requires confirmation
→ social objects and shared rooms follow their separate ownership rules
```

---

## 11. Agents, schools, and world life

Agents represent functions or traditions, not fake people presented as real experts.

Useful roles include:

- evidence seeker;
- counterexample hunter;
- historian;
- mechanism explainer;
- skeptic;
- school representative;
- synthesizer;
- simulation operator;
- question keeper;
- verifier.

An agent may change its position when evidence changes. A faction may form. A room may generate a Relic. None of those outputs becomes factual merely because the simulation was lively.

Agent activity can alter the world only through typed deltas and risk gates. Cosmetic life may appear automatically. Source-backed synthesis may appear after automated checks. Sensitive factual claims, real-person depictions, high-stakes guidance, and unvalidated generated code require stricter review or remain blocked.

---

## 12. Truth, provenance, and fictional boundaries

Every encounter has one primary truth state:

| State | Meaning | Required presentation |
|---|---|---|
| **documented** | directly supported by strong cited evidence | source access and date |
| **synthesis** | a source-grounded explanation produced by the system | sources plus generated label |
| **interpretation** | a reasoned perspective rather than settled fact | perspective and counterview |
| **disputed** | credible sources materially disagree | disagreement visible before action |
| **modelled** | produced by an explicit simulation or causal model | assumptions, model, uncertainty |
| **counterfactual** | explores a world that did not occur | divergence point and assumptions |
| **fictional** | invented for narrative or play | unmistakable fictional framing |

Generated video, imagery, voices, and characters are labelled at the artifact level. Sources support claims, not visual realism. Real people are not made to perform invented actions without appropriate rights and safeguards.

Corrections propagate. A saved Relic may retain its historical form but must show that a claim was corrected or superseded.

---

## 13. Social model

KnowScroll is social because other people expose us to worlds our individual systems would not discover.

The social primitives are:

- share an encounter or branch;
- share a selected world projection;
- visit a friend's universe;
- co-voyage through a world;
- enter a shared Idea Room;
- create a temporary Blend;
- preserve a room Relic;
- send a private route connected to an encounter.

KnowScroll is not a public identity-performance network. There are no follower-count leaderboards, public learning scores, or competition over whose universe is largest.

### Blend

A Blend is a temporary third projection computed from explicitly shared regions. It does not merge private models or permanently change either universe. It can reveal:

- overlap;
- complementary depth;
- unexplored bridges;
- genuine disagreement;
- a route worth taking together.

Both participants can end the Blend. Revocation removes future access even if the other person saved their own resulting Relic.

---

## 14. What the product is not

KnowScroll is not:

- a course platform with gamified planets;
- an Instagram clone with educational captions;
- a user-maintained knowledge graph;
- a personality test visualized as space;
- an AI-generated content firehose;
- a fully autonomous society trusted to invent truth;
- a productivity dashboard;
- a public status competition;
- a 3D game that hides slow navigation behind spectacle;
- a claim that all screen time becomes healthy when the subject is intellectual.

---

## 15. Deliberate non-features

The first product does not include:

- editable interest percentages;
- manual planet creation or deletion;
- drag-to-arrange universe authoring;
- prompt boxes on every surface;
- public follower counts;
- streaks or XP;
- a generic inbox copied from Instagram;
- arbitrary user-uploaded agent personalities;
- generated real-person avatars;
- direct model-provider calls from the client;
- open-ended generated code outside a sandbox;
- invisible truth-state promotion;
- claims that the model knows every book ever written;
- a marketplace, creator economy, or startup-scale moderation system.

This is a personal product for the owner and a few trusted friends. Architecture should preserve correctness and future options without pretending to need global scale.

---

## 16. Success and failure

### 16.1 North-star outcome

After repeated use, the person can point to ideas, questions, people, and relationships they would probably not have encountered otherwise; explain something they discovered about their own assumptions, curiosity, or way of thinking; and identify encounters that changed what they later noticed, asked, made, discussed, predicted, or believed.

### 16.2 Product measures

Useful measures include:

- substitution: opened KnowScroll instead of the intended doomscroll app;
- residue: saved Relic, prediction, question, branch, later recall, or later use;
- self-discovery residue: a revisited assumption, contradiction, changed prediction, new question, or explanation preference the person recognizes in their own journey;
- model quality: stronger connections, better-calibrated predictions, serious engagement with alternatives, and revision when evidence changes;
- frontier rate: meaningful encounters outside already dominant worlds;
- branch quality: horizontal continuations that lead to depth rather than repetition;
- diversity over weeks, not just within one session;
- source access and correction rate;
- world return: revisiting a world for a new reason;
- social exposure: a friend causes a valuable new path;
- inference calibration: hypotheses that survive later evidence vs decay or correction;
- fatigue and regret after a session;
- percentage of generated objects that pass quality gates without human repair.

### 16.3 Anti-metrics

These must not become success proxies:

- total minutes watched;
- longest streak;
- maximum number of swipes;
- content generated per day;
- planets accumulated;
- notifications opened;
- agent messages produced;
- model confidence without later calibration.

### 16.4 Failure conditions

The product has failed if:

- the universe becomes decorative navigation around a normal feed;
- one dominant interest consumes the map;
- generated media outruns source quality;
- the Engine creates a self-confirming psychological portrait;
- users cannot tell fact from simulation or fiction;
- Scrolls become ordinary articles with animated garnish;
- agents create motion without intellectual value;
- world changes cannot be explained or rolled back;
- social visits leak private inference;
- the product replaces doomscrolling with equally compulsive self-improvement guilt;
- desktop and mobile feel like separate products;
- the owner cannot tell what runtime actually produced an encounter.

---

## 17. Three delivery phases

There is one short validation gate before implementation phases. It is not a fourth product phase.

### Validation gate: prove the grammar before the cosmos

Build a disposable but polished prototype containing:

- one universe-to-world transition;
- one world-to-Reel transition;
- one world-to-Scroll transition;
- vertical discovery and horizontal continuation in both objects;
- one embedded Scroll interaction;
- one Enter World and exact Return path;
- mobile and desktop layouts.

Test with the owner and friends. Do not build the World Engine until the transition grammar feels like one coherent product.

**Gate evidence:** people can begin in under five seconds, understand vertical vs horizontal without instruction, enter a world without disorientation, use an embedded Scroll block without accidental navigation, and say that the experience feels neither like homework nor a themed feed.

### Phase 1: A universe that learns

Deliver a private end-to-end product for the owner:

- authentication and private-by-default state;
- personal universe and three seed world archetypes;
- Cable mixed stream and Interdimensional Scroll;
- sourced Reels and interactive Scrolls;
- a closed `Reel | Scroll` renderer and stream contract;
- declared cognitive intent for every encounter and evidence-safe journey residue;
- Continuity Capsules for every cached or sourced horizontal continuation;
- Tier 0 retrieval and Tier 1 semantic branch preparation during attention;
- fast candidate pipeline with diversity/frontier reranking;
- observation and exposure ledger;
- conservative behavioral hypotheses with evidence and decay;
- basic slow World Engine that can materialize explained paths, moons, and frontiers;
- Why this appeared?;
- Relics, traces, predictions, corrections, pause, reset, export, and delete;
- golden journey receipts.

**Deliverable:** the owner can replace a doomscroll session, follow a branch, enter its world, later see a source-linked universe change caused by the journey, and recognize one evidence-backed change in what they noticed, questioned, predicted, or understood about their own thinking.

### Phase 2: Living worlds

Deliver research, generation, and bounded autonomy:

- research harness with retrieval and claim provenance;
- MiniMax M3 or a benchmarked equivalent behind a provider port;
- H3 Reel generation pipeline with queue, receipts, truth labels, and cost limits;
- generative series and alternative branches anchored by terminal-frame continuity;
- Tier 2 speculative branch preparation with budgets, cancellation, expiry, and no false exposure evidence;
- blind Visual Witness and Encounter Reconciler gates for generated Reels;
- full interactive Scroll block registry;
- portable executable Relics with typed payloads, permission checks, and execution receipts;
- recursive per-world Engines;
- Schools of Thought, Idea Rooms, and bounded inhabitants;
- world ticks while the person is away;
- stars, black holes, ruins, supernovas, and semantic lineage;
- simulation and generated-code sandboxes;
- automated evaluation, shadow mode, and risk-tier publication.

**Deliverable:** a question or pattern can cause the Engine to research, prepare a continuous branch, reconcile the rendered result against source and visual evidence, create a Reel and Scroll path, carry a typed Relic into the next context, stage an agent discussion, and change a world with a complete receipt and no manual planet authoring.

### Phase 3: Worlds collide

Deliver the trusted social system:

- friend connections and visibility policy;
- selected universe projections;
- visit and revoke;
- shared encounters and private routes;
- co-voyage;
- shared Idea Rooms;
- temporary Blend;
- social exposure in ranking without profile leakage;
- world translation through shared semantic anchors;
- notification restraint and abuse controls.

**Deliverable:** two friends with different universes can visit, discover a meaningful gap, explore a temporary blended route, create a shared Relic, and separate again without either private model leaking or being overwritten.

---

## 18. Decisions still to validate, not reopen casually

These are hypotheses with a chosen first implementation:

| Question | Chosen first answer | Evidence that could change it |
|---|---|---|
| Should streams be finite? | No; use infinite rolling streams without obligation mechanics | user regret, fatigue, or failure to substitute meaningfully |
| Should users edit their model? | No profile or universe editor; only non-authoring safety controls | repeated harmful inference that cannot be corrected locally |
| How many consumption formats? | exactly two primary objects: Reel and Scroll | a required journey cannot fit either without becoming incoherent |
| Can worlds change while away? | yes, through bounded typed ticks and risk gates | changes feel arbitrary or validation remains unreliable |
| Is engagement optimized? | only as an interestingness/continuation constraint | low continuation prevents any exposure; weights may need recalibration |
| Is the universe shared geography? | shared semantic substrate, personal emergent geography | social translation proves incomprehensible |
| Does H3 belong in the critical path? | no; video generation is queued and replaceable | provider latency and cost become reliably negligible |
| Does M3 run the entire system? | candidate research/orchestration provider behind a port, not a database authority | benchmark proves a more appropriate model or local system |

---

## 19. Canonical vocabulary

Use these words consistently:

- **World Engine**: the persistent observe–infer–research–create loop.
- **Universe**: one person's emergent intellectual possibility space.
- **World**: a domain instance inside that universe.
- **Epistemic substrate**: shared sources, claims, concepts, and relationships beneath personal geography.
- **Reel**: short branchable audiovisual encounter.
- **Scroll**: interactive explorable document.
- **Cable**: mixed Reel + Scroll infinite stream.
- **Interdimensional Scroll**: Scroll-only infinite stream.
- **Branch**: a continuation, explanation, opposition, example, or counterfactual descended from an encounter.
- **Relic**: durable saved or created artifact.
- **Trace**: lightweight mark of passage.
- **World tick**: bounded background evolution cycle.
- **Hypothesis**: uncertain evidence-linked inference about a person or world.
- **Treatment**: an exposure selected by the system that may affect later behavior.
- **World delta**: typed proposed change to personal universe or world state.
- **Chronicle**: human-readable record of meaningful world changes and their lineage.
- **Inhabitant**: bounded agent occupying a School or Room.
- **Physics**: objectives, constraints, policies, contracts, and evaluation that govern emergence.

Deprecated terms:

- “editable personal model”;
- “accepted model delta” as a routine user workflow;
- “finite Cable edition”;
- “Scroll” meaning a saved artifact;
- “canonical shared geography” as the visual truth for every user;
- “no autonomous loop.”

---

## 20. Final product statement

KnowScroll is a place a person can open for the same reason they open a social feed:

> **I have a few minutes. Show me something interesting.**

Underneath that simple request, a World Engine watches the journey, treats every signal as uncertain, researches beyond the model's memory, creates credible encounters, lets worlds and inhabitants evolve, and changes the universe around what the person is becoming capable of seeing.

The person does not administer the system.

They live inside it.

They watch, read, ask, skip, argue, predict, create, share, and wander.

Reels make entry effortless. Scrolls make depth playable. Worlds make ideas situated. Friends make individual blind spots visible. The universe makes expansion legible over time.

**We build the laws of the universe.**

**The person lives inside it.**

**The World Engine watches what happens.**

**And the universe grows organically around the journey.**
