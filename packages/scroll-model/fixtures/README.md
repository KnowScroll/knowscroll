# scroll-model fixtures

**CI fixtures. Not product content.** Authored examples used by this package's tests and, later, by
renderer tests. They are never imported into the inventory or shown to readers, and every
provenance file says so (`production.kind: "fixture"`).

| Name | What it exercises |
|---|---|
| `attention-slowly` | poster template; drag-to-target diagram (two-axis gesture); heatmap chart whose caption number is anchored to a claim; illustrative slider simulation (`power` and `ratio`, readout with bands); disclosure holding a paragraph with inline code and a code block; table; limit callout |
| `weight-other-worlds` | non-illustrative simulation with a **personal** number input and `cards` view: constants bound by constant bindings, its range and default by value bindings, every number of its fallback text anchored; bar chart bound to claims; key-idea and limit callouts |
| `spring-neap-tides` | editorial template; step-through diagram on the grid layout; illustrative slider simulation with `linear` and `ratio` outputs, `cards` view and readout bands; timeline; limit callout |

Files per fixture:

- `documents/<name>.json` — the committed consumer document (each simulation carries the `display`
  scale that admission computed from its grid). The only fixtures exported to other
  packages (`@knowscroll/scroll-model/fixtures/<name>.json`), for renderer tests.
- `producer/<name>.draft.json` — what a writer model would return (`scroll-draft.v1`, untrusted
  input);
- `producer/<name>.provenance.json` — the compile input (`scroll-draft-provenance.v1`): identity,
  framing, claims, sources, offered media, production record;
- `producer/<name>.internal.json` — the committed internal provenance.

`producer/` holds claims, sources and URLs: it is not exported and dependency-cruiser keeps client
code out of it (`clients-never-import-scroll-producer-fixtures`).

Claims in `attention-slowly` and `weight-other-worlds` (including `clm-weight-range`, which the weight
simulation's input range binds to) are placeholders (`FIXTURE PLACEHOLDER`
quotes, `fixture.invalid` sources). The two claims in `spring-neap-tides` are the real NASA passages
from the frozen v1 library pack `content/model-scrolls/1aca9029bc97-3b65ffaa9073.json`.

Regenerate the outputs after a deliberate change to compile, measures or hashing:

```sh
pnpm --filter @knowscroll/scroll-model fixtures   # builds, then runs regenerate.mjs
pnpm format
```

## Stage fixtures of the drawing kits (v2)

`documents/{tides,greenhouse,star,transit}-stage-ci.json` are labelled CI fixtures of `scroll-document.v2` Scrolls,
one for each drawing kit of D-194, for the stage reader's end-to-end check (`kit-stage-smoke.spec.ts`) and the kit
screenshots. They are shorter than a Scroll may be, so only the reading time is outside the limits; the rest is
validated, and the file carries correct measures and hash. Regenerate after a change to a kit's words or text:

```sh
pnpm --filter @knowscroll/scroll-model build && node packages/scroll-model/fixtures/regenerate-kits-v2.mjs
pnpm format
```
