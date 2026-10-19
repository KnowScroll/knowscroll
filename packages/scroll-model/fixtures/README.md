# scroll-model fixtures

**CI fixtures. Not product content.** Authored examples used by this package's tests and, later, by
renderer tests. They are never imported into the inventory or shown to readers, and every
provenance file says so (`production.kind: "fixture"`).

| Name | What it exercises |
|---|---|
| `attention-slowly` | poster template; drag-to-target diagram (two-axis gesture); heatmap chart; slider simulation (`power` and `ratio`, readout with bands, illustrative); disclosure holding a paragraph with inline code and a code block; table; limit callout |
| `weight-other-worlds` | simulation with a **personal** number input and `cards` view, constants bound to claims (non-illustrative); bar chart bound to claims; key-idea and limit callouts |
| `spring-neap-tides` | editorial template; step-through diagram on the grid layout; slider simulation with `linear` and `ratio` outputs, `cards` view and readout bands; timeline; limit callout |

Files per fixture:

- `<name>.draft.json` — what a writer model would return (`scroll-draft.v1`, untrusted input);
- `<name>.provenance.json` — the compile input (`scroll-draft-provenance.v1`): identity, framing,
  claims, sources, offered media, production record;
- `<name>.document.json` — the committed consumer document compiled from the two;
- `<name>.internal.json` — the committed internal provenance.

Claims in `attention-slowly` and `weight-other-worlds` are placeholders (`FIXTURE PLACEHOLDER`
quotes, `fixture.invalid` sources). The two claims in `spring-neap-tides` are the real NASA passages
from the frozen v1 library pack `content/model-scrolls/1aca9029bc97-3b65ffaa9073.json`.

Regenerate the outputs after a deliberate change to compile, measures or hashing:

```sh
pnpm --filter @knowscroll/scroll-model fixtures   # builds, then runs regenerate.mjs
pnpm format
```
