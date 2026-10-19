# Gate 2 contracts: observations, intent, plans, supply and worlds

Companion to [the architecture](02-architecture.md). These are proposed wire/domain contracts for review, not implemented TypeScript, SQL migrations or accepted API schemas. Examples use readable aliases such as `u_asha` and `exp_101`; production identifiers would use the repository's validated opaque ID format.

## 1. Common rules

Server-side durable envelopes carry `schemaVersion`, a stable message ID (the contract-specific `eventId`, `demandId` or other named ID), `recordedAt`, `causationId` and `correlationId`. Observations also carry `occurredAt`; derived records retain their input time range. Person-scoped server records also have `universeId` and `privacyEpoch`. JSON examples below show client/domain payloads; server-added envelope metadata is omitted for readability. The authenticated server supplies ownership and epoch authority; a client-provided expected epoch is only a precondition. Public supply messages do not include a private universe ID.

Distinguish these versions:

| Field | Meaning |
|---|---|
| `schemaVersion` | Shape and interpretation of this contract. |
| `policyVersion` | Deterministic rules and numeric configuration used. |
| `modelVersion` / `promptVersion` | Model and prompt used to produce a proposal or assessment. |
| `assetRevision` | Exact content actually offered or encountered. |
| `evidenceRevision` | Current interpretation of one exposure's accumulated valid observations. |
| `projectionRevision` | Applied personal projection state. |
| `structureRevision` | Applied semantic geography state. |
| `sceneRevision` | Published visual representation state. |
| `privacyEpoch` | Authority fence; never a substitute for erasure. |

Use strict validation. Unknown semantic event types are rejected; clients negotiate capabilities rather than silently sending fields that older servers ignore. Additive metadata must have an explicitly permitted extension area. Incompatible changes get a new schema version and a documented reader/upcast path.

A duplicate identifier with identical canonical payload is a retry. The same identifier with a different payload is a conflict. Immutable records are superseded by new revisions; current projections may be replaced atomically. Input hashes and retained references obey the same privacy scope as their underlying data.

## 2. InteractionEnvelope — what the interface observed

**Producer:** client observation adapter, enriched by authenticated intake. **Consumer:** evidence normalizer. **Storage:** bounded intake log/transport, then retained evidence lineage. **Output:** accepted/rejected observation result and eventually EncounterEvidence.

| Required field | Type / constraint |
|---|---|
| `schemaVersion`, `eventId` | Version string; stable ID reused across retries. |
| `sessionId`, `deviceSessionId`, `sequence` | Scoped session handles and monotonic device-session sequence. Sequence gaps are allowed; no global clock ordering is inferred. |
| `occurredAt`, `clientMonotonicMs` | Client wall time plus monotonic offset for intervals; server also adds `receivedAt`. |
| `exposureId`, `decisionId`, `assetId`, `assetRevision` | Required for encounter observations; server checks token/offer lineage. |
| `threadId`, `navigationStepId` | Thread and step in which the encounter occurred. |
| `kind` | One allowlisted observation type. |
| `payload` | The versioned payload for that kind; finite numbers, bounded lists and sizes. |
| `clientVersion`, `telemetryPolicyVersion` | Which client and instrumentation semantics produced it. |
| `causationId` | Previous navigation/action when known; not an LLM-invented explanation. |

Initial kinds and payload meanings:

- `encounter_visible`: actual viewport visibility start, fraction and surface state.
- `playback_summary`: unique media intervals, active visible playback time, automatic-loop count, deliberate replay count and stalls. Coalesce locally; do not emit each frame.
- `reading_summary`: visible section IDs, active dwell per section and deepest stable reading anchor. End-of-article alone is not evidence of reading.
- `component_interaction`: approved component ID and semantic action such as changing a simulation parameter; exclude raw keystrokes and pointer paths.
- `encounter_hidden`: backgrounded, moved away or covered; closes an interval.
- `share_completed`: completion signal supported by the platform, with capability/confidence. If the platform only exposes a sheet open, record `share_sheet_opened` and assign no completed-share contribution.

Like, Save, Hide and navigation are commands with authoritative outcomes; they are not duplicated as client-success observations. Their committed action events are consumed by the evidence pipeline. A client can separately record an unsuccessful tap for interface diagnostics without treating it as a completed action.

```json
{
  "schemaVersion": "interaction.v1",
  "eventId": "evt_101",
  "sessionId": "session_asha_1",
  "deviceSessionId": "device_session_1",
  "sequence": 12,
  "occurredAt": "2026-10-18T10:00:48Z",
  "clientMonotonicMs": 48000,
  "exposureId": "exp_101",
  "decisionId": "dec_101",
  "assetId": "reel_attention_1",
  "assetRevision": 3,
  "threadId": "thread_attention",
  "navigationStepId": "step_1",
  "kind": "playback_summary",
  "payload": {
    "mediaDurationMs": 50000,
    "uniqueMediaIntervalsMs": [[0, 42000]],
    "activeVisiblePlaybackMs": 42000,
    "automaticLoops": 0,
    "deliberateReplays": 0,
    "stallMs": 0
  },
  "clientVersion": "example-client",
  "telemetryPolicyVersion": "telemetry-draft-1",
  "causationId": "activate_101"
}
```

The payload is illustrative client evidence, not trusted measurement truth. Clip impossible intervals to validated content duration or reject malformed data; merge overlaps; cap rates; exclude background and buffering. Derived quality states retain uncertainty and instrumentation gaps. A person with telemetry disabled still receives content; recording policy determines which personal projections may change.

## 3. EncounterEvidence — what can support personal state

**Producer:** normalizer and deterministic qualifier. **Consumers:** personal projector, Planner context builder, Cartographer input builder. **Storage:** latest evidence plus retained revision lineage within privacy/retention policy.

| Field | Meaning |
|---|---|
| `evidenceId`, `exposureId`, `evidenceRevision` | Stable identity and monotonic revision for one exposure. |
| `universeId`, `privacyEpoch` | Current authorised scope. |
| `assetId`, `assetRevision`, `explanationUnitId` | Physical asset and conceptual deduplication unit. |
| `observationRefs`, `committedActionRefs` | Exact accepted facts contributing to this revision. |
| `conceptAttribution` | Topic IDs with normalised weights, facet IDs and admitted source-family references. |
| `consumption` | Visible active time, unique coverage, section coverage, qualification status and uncertainty. |
| `channels` | Qualified consumption, like/save/share/continue/return/dismiss facts as separate values. |
| `origin` | System offer, explicit request, room-opened content, or supported fresh return. |
| `eligibility` | Whether this evidence may affect routing and formation, separately. |
| `policyVersion`, `cohortRef` | Rules and duration/read-size cohort used. |
| `supersedesRevision`, `correctionCause` | Late-event or source/privacy correction lineage. |

Example semantic result from `evt_101`: `ev_101@1` says Asha had a qualified visible encounter with explanation unit `unit_attention_mechanism`. It does not say she understands attention. Its qualified-consumption channel may be `0.8` under an illustrative cohort policy. The exact number is not inferred solely from 42/50 seconds.

When `cmd_continue_102` commits, `ev_101@2` adds the continuation channel once. The projector applies `revision 2 − revision 1`, not the full encounter again. A unique key on the consumed evidence revision or an equivalent idempotent revision ledger prevents duplicates. A format twin can produce another encounter but cannot increase the distinct explanation count for this unit.

## 4. ExperienceContext — the fast decision input

**Producer:** personal projector plus session state adapter. **Consumer:** Composer. **Storage:** bounded person-scoped read model; session overlay may be ephemeral. It is not an autobiography or a transcript summary.

Fields:

- `contextId`, `projectionRevision`, `privacyEpoch`, `builtAt` and per-input watermarks.
- `sessionIntent`: mode, topic constraint, thread ID, requested format and latest intent revision.
- `topicActivity`: a bounded top/relevant topic list with separate channel aggregates and timestamps.
- `formatPreference`: topic × format estimates, sample mass and uncertainty; neutral prior where sparse.
- `recentEncounters`: bounded asset/unit/topic references for repetition control.
- `activePlanRef`: validated plan revision and expiry, or null.
- `constraints`: hidden topics/assets, language, accessibility and authorised content scope.
- `inventoryRevision`: freshness hint; final publication/access checks remain authoritative.
- `provisionalTail`: unprojected event IDs and session-only effects, explicitly marked provisional.

Composer must record which immutable snapshot references and provisional observations it used. Reusing an old context after a privacy clear is forbidden even if a cache says it has not expired. A football request changes `sessionIntent` immediately; long-term `topicActivity` does not become football-dominated on that basis.

## 5. ExplorationPlan — what could be useful next

**Producer:** Planner harness proposal, then deterministic plan validator. **Consumers:** Composer and Quartermaster. **Storage:** per-person plan revisions, with active pointer and expiry. **No direct Cartographer application.**

| Field | Meaning |
|---|---|
| `planId`, `planRevision`, `runId` | Plan identity and producing harness run. |
| `baseProjectionRevision`, `evidenceRefs` | The actual evidence considered. |
| `privacyEpoch`, `validUntil` | Authority and staleness limits. |
| `opportunities` | Bounded list of topic/angle/continuity opportunities, each with evidence refs. |
| `constraints` | Topics, format override, language, depth and allowed scopes. |
| `demandProposals` | Optional requests to prepare unavailable content. |
| `modelVersion`, `promptVersion`, `policyVersion` | Reproducible provenance of proposal and acceptance. |
| `validation` | Accepted/rejected/superseded; reason codes stay internal. |

An opportunity has an ID, topic IDs, explanatory move (`example`, `mechanism`, `limitation`, `perspective`, `connection`), thread eligibility, preferred formats conditioned on topic and an optional semantic relation reference. Its internal justification points to facts such as a continuation action; it must not assert a psychological reason.

Plans can expire without removing worlds. Plan completion is not a user-facing checklist. A proposed relation absent from the admitted substrate must go through semantic validation before it can be represented as an established connection.

## 6. ContentDemand — a private need with a shareable supply brief

**Producer:** explicit request, Composer gap or admitted Planner proposal. **Consumer / owner:** Quartermaster. **Storage:** private demand plus separate shared supply request and waiters.

Fields:

- `demandId`, `origin` (`explicit`, `composer_gap`, `planner_prefetch`), `originRef` and idempotency key.
- Private owner scope, epoch, current status, creation/expiry and cancellation state.
- `topicIds`, `explanatoryAngle`, `depthBand`, `language`, `requestedFormat` and `freshnessRequirement`.
- `explanationUnitId` when requesting a variant of a specific explanation.
- `continuityRequirement`: thread scope; exact prior unit and series revision for a sequel; or permitted related move.
- `publicBriefRef`: sanitised shareable specification, or null for a private brief.
- `sharingClass`: public-canonical or explicitly scoped private. No automatic public promotion of personal text.
- `priorityClass`, maximum admitted cost, deadline and acceptable fallback behavior.
- `supplyKey`, `resolution`, `supplyRequestId`, `resolvedAssetRef` and last decision revision.

Resolution states: `unresolved → reused | joined | admitted_new | admitted_adaptation | deferred | refused`; admitted/joined work can later become `ready | failed | cancelled`. Provider execution states belong to the supply attempt, not this private demand. Two users can have different demand statuses for the same shared job because permissions, deadlines or cancellation differ.

```json
{
  "schemaVersion": "content-demand.v1",
  "demandId": "demand_scroll_201",
  "origin": "explicit",
  "originRef": "cmd_format_201",
  "universeId": "u_asha",
  "privacyEpoch": 7,
  "topicIds": ["ml", "attention"],
  "explanatoryAngle": "attention as context-dependent token weighting",
  "depthBand": "intuitive-mechanism",
  "language": "en",
  "requestedFormat": "Scroll",
  "explanationUnitId": "unit_attention_mechanism",
  "continuityRequirement": {
    "kind": "same_explanation",
    "threadId": "thread_attention",
    "fromAssetId": "reel_attention_1",
    "fromAssetRevision": 3
  },
  "sharingClass": "public-canonical",
  "publicBriefRef": "brief_attention_mechanism_scroll_v1",
  "priorityClass": "explicit",
  "status": "unresolved"
}
```

The public brief excludes `u_asha`, her history and her private text. If she asks to explain a confidential work document, that demand cannot join a public job merely because the topic vector is similar. A canonical public variant may later serve many people; the fact it was commissioned for someone is not exposed.

## 7. UniverseDelta — the only application boundary for personal geography

**Producer:** deterministic Cartographer applier after validating a semantic proposal and formation rules. **Consumers:** scene projector, universe read API, permitted history view. **Storage:** ordered person-scoped structural changes and current geography.

Fields:

- `deltaId`, `universeId`, `privacyEpoch`.
- `baseStructureRevision`, `newStructureRevision`, `baseEvidenceRevision` or explicit evidence snapshot reference.
- `proposalId`, `runId` where a model proposed it; policy-only updates can have no model run.
- `operations`: bounded typed list such as `create_system`, `establish_star`, `form_planet`, `add_region`, `connect_route`, `revise_label`, `set_activity`, `withdraw_relation`.
- Each operation has stable object IDs, topic IDs, parent/edge references, evidence references and a non-psychological semantic label.
- `formationPolicyVersion`, `validationReceiptId`, `appliedAt`.

Atomic application checks the universe lock, current epoch, object ownership, all references, structure revision, evidence eligibility, threshold/variety rules and operation limits. Apply all operations or none. Do not allow arbitrary JSON patches, embedded SQL, renderer code or model-authored opacity about why a place exists.

A scene update may follow later. `UniverseDelta applied` does not mean `client displayed the animation`. If a semantic correction removes a relation, the history records that correction; it does not announce that the person changed their belief.

## 8. SceneManifest — a renderable, stable view

**Producer:** scene projector. **Consumers:** mobile/web renderers and permission-filtered visitor views. **Storage:** small manifest index plus per-system/object chunks.

| Field | Meaning |
|---|---|
| `manifestId`, `schemaVersion`, `sceneRevision` | Versioned view identity. |
| `structureRevision`, `activityRevision` | Semantic structure and separate visual activity represented. |
| `accessScope`, `visibilityRevision` | Owner or revocable visitor view. Not a substitute for server authorisation. |
| `objects` / `chunkRefs` | Stable IDs, parent hierarchy and descriptors for visible objects. |
| `semanticRef` | Reference to the object/topic represented; no private inference text. |
| `visualFamily`, `seed`, `generatorVersion` | Shared family plus stable, opaque personal variation. |
| `layoutAnchor`, `regionLayout` | Stable placement and meaningful regions; procedural detail fits around them. |
| `material`, `atmosphere`, `motionState`, `lodOptions` | Bounded renderer parameters, including reduced motion and static fallback. |
| `navigationTargets` | Typed targets opening actual Reel/Scroll encounters, places or authorised rooms. |
| `transition` | Optional applied-delta animation with a stable transition ID; never an instruction to mutate meaning. |

A renderer can skip an animation after reconnecting and show the correct final scene. An older client that cannot render a descriptor receives a compatible fallback, not executable arbitrary code. Private evidence IDs and hidden regions must be removed from a visitor manifest, including indirect hints in object counts or navigation targets.

## 9. Supporting contracts that make the seven primary contracts work

### NavigationCommand and CommandReceipt

`requestId`, `expectedPrivacyEpoch`, `sessionId`, `expectedIntentRevision`, `fromExposureId`, `mode`, and a typed intent payload. Modes include `vertical`, `continue_thread`, `return_step`, `same_explanation_format`, `explicit_topic` and `open_place`. Each mode has its own required references; a generic screen swipe is not enough.

The receipt returns `commandId`, input hash, committed intent revision and one of:

- `ready`: prepared offer references with actual admitted assets;
- `pending`: demand ID and observable status;
- `exhausted`: the thread currently has no eligible continuation;
- `refused`: scoped reason and allowed recovery action.

A response may include a ready alternative only if it is explicitly labelled as an alternative; a requested Scroll is not fulfilled by an unrelated Reel.

### ThreadState and ContinuityLink

A thread stores its ID, starting intent, current scope, visited steps, current step, resume anchors and intent revision. A step links a real asset revision to an explanation unit and a continuation reason.

Two distinct link kinds:

| Kind | Required evidence and behavior |
|---|---|
| `series_next` | Stable series ID/revision, previous unit, next unit, ordinal and editorial continuity validation. The next part advances the same promised explanation without unnecessary repetition or missing prerequisites. |
| `related_move` | Admitted same-thread relation and an explicit move such as example, mechanism, consequence, alternative perspective or limitation. No part number is implied. |

Series membership belongs primarily to explanation units; Reel and Scroll variants can represent the same part. A numbered sequence can be planned, but the UI only claims an available part when that asset is admitted. A missing part can be requested with a pending state. If the user explicitly asks for Part 2, do not substitute a generic related item as though it fulfilled the command.

Horizontal back restores a visited step and its reader anchor. Restoration is not a new exposure. If a fresh encounter is deliberately activated later, it receives a new exposure with return lineage; the distinct conceptual-unit count still deduplicates.

### PublishedEncounter

Inventory entry: `assetId`, `revision`, `kind` (Reel or Scroll), `explanationUnitId`, topic/facet tags, language, duration/read-size metadata, source/claim package reference, validity/publication state, rights/access class, variant relations and optional continuity links. Client content projections omit internal research and ranking data.

A Reel references playable admitted media and accessibility tracks. A Scroll references a validated declarative article document. Supply completion without publication admission cannot enter a candidate pool.

### HarnessRun, ContextBundle and ProposalEnvelope

Specified in [02c-harness.md](02c-harness.md). They carry role, authority, budgets, frozen evidence references and output schemas. Neither a transcript nor a compaction summary is authoritative encounter evidence.

### ProjectionNotice and WorkRequest

A `ProjectionNotice` says a particular view advanced from revision X to Y and points to canonical state. A `WorkRequest` asks a named loop to process an authorised revision with a dedupe key. Receiving either twice is safe. Publishing a notice and advancing its state occur through a transaction/outbox boundary; consumers do not rely on best-effort in-process notifications.

## 10. Lifecycle and retention decisions

Proposed starting review values: a short client retry queue, observations retained for days rather than indefinitely, compact encounter evidence retained according to the user's history policy, and limited diagnostic model transcripts with deletion hooks. Exact durations are deliberately not hidden constants: they must be selected with privacy semantics, debugging needs and the ability to rebuild projections.

Long-lived aggregate state needs lineage sufficient to retract an erased or corrected contribution. If detailed evidence expires, a checkpoint may preserve only the fields permitted by the retention policy; it cannot promise exact reconstruction of discarded events. Personal request text, evidence references, embeddings and model summaries are all personal derived data, not exempt caches.

Clear-history, universe reset and account deletion have different existing scopes. Before adding these contracts, map every family to each control, including Kafka, dead-letter storage, model-provider retention, exports, caches and backups. Preserve the current retry semantics and name any expanded scope in a successor contract. Paused recording prevents new personal evidence/projections; existing content can still be browsed with the permitted ephemeral session behavior.

## 11. Contract acceptance checklist for the later implementation plan

- The same command or observation cannot cause a second durable effect.
- Each displayed encounter has valid decision/request and content-revision lineage.
- Prefetch, availability, model proposals and bot activity never count as personal encounters.
- Every model output is scoped, schema-checked and applied against fresh authority outside provider-call transactions.
- Horizontal parts, related moves and format twins remain distinguishable through production and UI.
- Privacy invalidation reaches caches, queued work, context bundles and retained transport payloads.
- The API can explain ready/pending/exhausted internally without exposing research or rationale UI.

These are review criteria, not claims that tests have been written or passed.
