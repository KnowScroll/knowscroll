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
Claims quote exact stored characters. Both role schemas include semantic checks inside the harness's
single repair allowance: at most two claims requests plus two writer requests, **four total**.
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

| Identity | v1 | Current |
|---|---|---|
| Job policy / unique topic-version key | `scroll-production.v1` | `scroll-production.v2` |
| Claims role version | `scroll-production.v1` | `scroll-claims.v1` (explicit stage name; instructions/schema unchanged) |
| Writer role and provenance prompt version | `scroll-production.v1` | `scroll-writer.v2` |
| Research policy / draft DSL | `public-research.v1` / `scroll-draft.v1` | Unchanged |

The rejected v1 job, its stable run IDs and attempts stay untouched. A reviewed v2 invocation
creates a different job and role runs; it is not a resend or resume of v1. It still needs an explicit
coordinator allocation and costs at most four requests, with the same 4,000/12,000 role ceilings.
The synthetic example uses `example-only-claim`, outside the claims role's accepted `claim-`
namespace; it cannot be authorized by real offered claims. CI checks its JSON/schema/compilation
with fictional fixture evidence and its refusal under production evidence. It is not library content.
