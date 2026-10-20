# Scroll production

Writer roles belong to content (blueprint §§11,15); `production/` owns their briefs, schemas,
semantic checks, frozen research and application. `infrastructure/research` owns the public HTTP
boundary. The shared reasoning engine retains transport, admission and the external attempt ledger.

| Stored table | Role | Main query | Lifetime |
|---|---|---|---|
| `content.scroll_production_runs` (0015) | Authoritative, private topic/version job; research pages/passages, accepted claims, code-only outcomes, draft and revision pointer | Unique `(topic, policy_version)`, UUID | Nonpersonal public supply; retained for correction, no account erasure |
| `content.asset_revisions` / `asset_provenance` | Immutable admitted consumer bytes / internal evidence and generation lineage | Asset + revision | Shared content; no account erasure |
| `reasoning.production_*` (0013) | Role runs and every possible paid attempt | Stable claims/writer run UUID | Harness retention and liability policy |

`makeProduceScroll` reserves a topic/version, retrieves code-selected public pages, freezes original
plain-text passages with content-derived IDs, asks the claims role, asks the writer, and publishes.
The claims role selects offered evidence IDs; code hydrates exact stored characters. Both role
schemas include semantic checks inside the harness's single repair allowance: at most two claims requests plus two writer requests, **four total**.
Writer output is canonical `scroll-draft.v1`; `compileDraft` checks support bindings, numbers, copying,
structure and simulation honesty, then `admitDocument` checks the exact stored consumer bytes. Code
also refuses source names/web addresses in reader text and unbound narrative blocks. Numerical
checks and exact quotations do not prove semantic entailment: human sampling is still required.

No jobs are registered yet: the worker operator triggers this bounded sequence. Lock order:
production root → production job row → asset advisory lock → asset rows. Short transactions freeze
or apply data; HTTP/model waits never hold them. Each stage closes its harness run in the same
transaction as its accepted domain effect. Every rejection and final write requires its exact expected stage under the root and job lock.
A delayed research/closed-role delivery reports the advanced job instead of rejecting or invoking
its next stage; a concurrent/late result cannot apply after a terminal state. `--resume` explicitly continues the same frozen research, accepted claims and stable role
run IDs through the ledger after a crash; no new business run or hidden model retry is created.
An unknown attempt stays unknown and is never resent. Ordinary reruns report existing state;
terminal rejection stays rejected. A changed prompt, source list or policy requires a reviewed
version bump, never editing the old job or published revision.

Topic explanation identities are `legacy-cutroom-seasons-v5`, `legacy-cutroom-tides-v4`, and
`legacy-cutroom-greenhouse`, exactly matching the approved Reel import. The frozen v1 scripts are
continuity references only. No v1 Scroll or authored example is presented as generated content.
Neither private research nor provenance is reachable through content's client-facing read ports.

## Prompt repair and version boundaries

A real local v1 run completed its claims request, then both writer attempts were refused with
`OUTPUT_NOT_ONE_JSON_OBJECT`; no asset was published. The invalid reply text was not retained,
so its syntax cause is unknown. The catalogue contains reference grammar rather than literal
JSON; v2 makes that distinction explicit and adds one `JSON.stringify`-generated fictional syntax
example. This is a bounded prompt correction, not evidence that the earlier model copied grammar
or that the revised prompt will succeed. Parsing, schemas, admission and repair limits are unchanged.

| Identity | v1 | v2 | v3 | Current v4 |
|---|---|---|---|---|
| Job policy / unique topic-version key | `scroll-production.v1` | `scroll-production.v2` | `scroll-production.v3` | `scroll-production.v4` |
| Claims role version | `scroll-production.v1` | `scroll-claims.v1` (unchanged v1 instructions/schema) | `scroll-claims.v2` (selection only) | Unchanged |
| Writer role and provenance prompt version | `scroll-production.v1` | `scroll-writer.v2` | `scroll-writer.v2` (unchanged) | `scroll-writer.v3` |
| Research policy / draft DSL | `public-research.v1` / `scroll-draft.v1` | Unchanged | Unchanged | Unchanged |
| Evidence candidate recipe | None | None | `quote-candidates.v1` | Unchanged |

All four rejected v1/v2/v3 jobs, their stable run IDs and eleven attempts stay untouched. A reviewed v4 invocation
creates a different job and role runs; it is not a resend or resume of an earlier version. It still
needs an explicit coordinator allocation and costs at most four requests, with the same
4,000/12,000 role ceilings.
The synthetic example uses `example-only-claim`, outside the claims role's accepted `claim-`
namespace; it cannot be authorized by real offered claims. CI checks its JSON/schema/compilation
with fictional fixture evidence and its refusal under production evidence. It is not library content.

## Selection-only evidence in v3

A real v2 claims primary failed its truth-state enum; its repair failed two exact-quote checks.
Only safe paths/codes were inspected, so the rejected values and text edits are unknown. The v3
correction removes both free statement generation and quote transcription from this role.

Code first verifies the frozen page/passages and their content hashes, then derives at most 32
`quote-candidates.v1` entries. Each is a whole paragraph or a group of complete sentences,
40–600 original characters, with exact UTF-16 offsets and a hash binding policy, source URL,
page/passages and text. Long paragraphs are partitioned only at conservative sentence boundaries;
look-ahead keeps a short final caveat with a neighbouring sentence. Unpartitionable text, incomplete
long tails, duplicate identities, fewer than four candidates or pool overflow refuse before model
admission. No text is clipped, normalised or rephrased to fit, and no oversized pool is truncated.

The model sees the actual bounded ID/text pool and selects four to eight distinct offered IDs.
Its strict JSON has only `candidateIds`. Within the same one-repair schema, code rechecks pool
integrity/membership, then hydrates each statement and quote to the identical original substring,
assigning a hash-derived `claim-` ID. `documented` means a direct source quotation; it does not
mean proven world truth or verified entailment. The role cannot author synthesis, interpretation
or modelled claims. Relevance, faithful selection and final teaching quality still need human review.

The harness retains/revalidates the raw selection, not the transformed hydrated claims. The
content job stores those hydrated claims privately. Resume deterministically rebuilds the pool
from frozen pages and verifies the stored claims before writer admission. The writer creates
original prose using the separately versioned writer recipe; all research participates in the unchanged copy check,
and number, honesty, binding, parser and admission checks remain in force. CI fixtures cover raw
selection replay, source/claim tampering, foreign/duplicate IDs, long caveats, multiple sources,
max-four repairs, and byte preservation of terminal v1/v2 rows. No fixture is model generation.

## Compact writer recipe in v4

The real v3 greenhouse claims request succeeded. Writer primary was valid JSON but failed array
validation at masked paths; repair failed internal JSON syntax with a separator-category diagnostic.
Invalid answers were not retained, so neither exact fields nor punctuation are known. A smaller
recipe may reduce mistakes; CI does not establish a successful real generation.

Writer v3 asks for a finished 2–3 minute explanation (roughly 450–600 words), three short sections,
paragraphs, one useful comparison or toggle diagram, and a closing limits callout. The code's
computed measure and 2–8 minute admission contract are unchanged. Greenhouse uses a comparison
with nested RichText arrays; seasons/tides use useful bounded interactive states. The full canonical
catalogue remains authoritative, and each request includes exactly one matching JSON.stringify
fictional shape example. Nothing authored is published as generation.

The writer wire schema is directly exported `ScrollDraft.superRefine`: canonical arrays are
required before compilation, so schema-declared outer paths are available to existing safe repair
feedback. This removes only content's writer preprocessing wrapper; global compiler normalization
and strict JSON extraction remain unchanged. Copy-nine, binding, numeric, honesty, source/privacy,
interactive and admission checks still use the same one repair. Role identity and failure brake are
unchanged; writer provenance records `scroll-writer.v3`. CI preserves synthetic historical terminal
job/attempt bytes and tests both valid modes, malformed arrays and unchanged refusals.
