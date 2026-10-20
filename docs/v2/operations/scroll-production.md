# Producing the first Scroll library

Run the worker release operator with the selected world's child-process environment. Allowed
worlds are `local`, `ci`, `dev`, `stage`; production is refused before database/provider work.
The reasoning provider defaults to none; production additionally needs its explicit configuration
switch and the database `scroll-supply` root enabled at the exact current generation (0013).
`KS_SCROLL_PRODUCTION_GENERATION` is the explicit expected generation (default1); a newer
database generation is refused until the operator updates this value. The command never adopts
a replacement grant by reading its generation automatically.
Never create a personal universe to authorize shared production.

```
node dist/operator.js content produce-scroll --topic seasons --dry-run
node dist/operator.js content produce-scroll --topic seasons
node dist/operator.js content produce-scroll --topic tides
node dist/operator.js content produce-scroll --topic greenhouse
node dist/operator.js content produce-scroll --topic seasons --resume
```

The bound is **four model requests per topic**, including every structural and semantic repair:
claims primary + at most one repair; writer primary + at most one repair. Writer output ceiling is
12,000 tokens; claims is 4,000. A refusal, quota failure or unknown halts that job. No provider call
runs from CI. `--dry-run` reports the bound and does no research/database/provider work. Use the
owner's total grant ledger as an additional session-independent ceiling; daily harness caps are
not renewed permission to spend. Never place keys on a command line, in logs, reports or artifacts.

The operator prints bounded IDs, outcome/check codes and usage counts; never prompts, draft prose,
page excerpts or credentials. A repeated topic/version reports the existing revision or rejected
outcome. `--resume` explicitly re-enters unfinished stages using frozen pages, accepted claims and
stable harness run IDs. It does not overwrite terminal jobs or resend an uncertain attempt. If a
process may still be running, let its operation finish before resuming: the harness will treat a
concurrently dispatched attempt as uncertain and halt safely. Inspect unknown liabilities using
the reasoning operator; write-off records uncertainty, not proof of non-charge.

Research policy `public-research.v1`: individually reviewed HTTPS hosts, default port, no URL
credentials/query/hash, no cookies, manual redirects (at most three) with every URL/DNS answer
rechecked, public-address-only DNS pinned to the HTTPS connection with original hostname/SNI
verification, identity encoding only (compressed pages refused), at most 2 MiB HTML, bounded
plain-text extraction, soft-404 refusal. OpenStax is explicitly refused. Code chooses pages, never
the model. Snapshots/passages remain private in the nonpersonal production row.

Before claiming acceptance, label source inspection, CI fixture, real database, real provider,
browser/emulator/physical-device and dev/stage deployment evidence separately. Three genuine
model-generated Scrolls, at least two interactive, still require actual publication and reading
through the connected app. A fixture publication or green CI cannot establish this. Human quality
notes must cover accuracy, clarity, interactivity, unsupported inference and analogy limitations.

The current recipe is `scroll-production.v4`, with unchanged `scroll-claims.v2` and
`scroll-writer.v3` stage versions; the writer version is recorded as publication `promptVersion`.
Claims now select four to eight immutable offered evidence IDs. Code verifies source hashes,
complete original 40–600-character quote spans, offsets and membership, then hydrates statement
and quote to the same source text. `documented` labels a direct quotation, not proven truth or
verified entailment. The pool has at most 32 candidates; insufficient, corrupt, oversized or
unpartitionable pools refuse before provider admission. No source text is silently clipped.

The harness retains raw selections for exact same-run replay; writer resume also verifies privately
stored hydrated claims. This narrower role cannot author synthesis or interpretation. Writer v3 requests a finished 2–3 minute article using a smaller canonical recipe and one
mode-matched fictional syntax example. Comparison points explicitly contain span arrays. The
writer wire requires canonical arrays directly; global compiler normalization is unchanged.
The full catalogue, computed 2–8 minute admission contract, strict parser, research policy, reader
copy/honesty/number checks, admission, request bound and token ceilings remain unchanged. All four
rejected v1/v2/v3 jobs and eleven attempts remain immutable. Invoking the reviewed new version is a new allocated business run,
never an automatic retry of a rejected version. `--resume` applies only to an unfinished job of the
current recipe. New exact-head CI/review and coordinator allocation are required before generation.

New publications project the three reviewed topic IDs only after same-transaction writer closure,
exact job publication, provenance and attempt checks. A normal fixture transport/model stays
unattributed. Projection uses the existing 0016 baseline and weight guard; it creates no personal
evidence. Historical reconciliation is unavailable until a separately reviewed completed-run
attestation port exists; no actual historical generated publication currently needs it. Deploy
requires the actual ordered schema through 0017, including 0015, and a matching reviewed build.
