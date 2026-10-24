# v2.1 design reference

`KnowScroll-design-v2.1/` is the static export of the product design canvas (19 October 2026), copied unchanged from the owner's download. `KnowScroll-design-v2.1.sha256` lists the SHA-256 of every file; CI checks the copy against it.

- Start with `KnowScroll-design-v2.1/index.html` and `README.txt`. `html/Tokens.html` and `html/Components.html` define the visual system; `html/Prototype-storyboard.html` shows every step of the clickable journeys.
- `source/` holds the editable canvas sources; they need the canvas runtime to render.
- Open the HTML with an internet connection so the fonts load (the same fonts are vendored in `packages/design-tokens/fonts/`).

**This is a visual specification, not evidence.** All people, messages, content and worlds are authored examples. Interactions are drawn, not implemented. Where the export conflicts with the blueprint or the product rules, `../decisions.md` (D-006) records the resolution. The coverage matrix mapping each artboard to a route, contract, issue and evidence lives on the main tracker issue.

`fidelity.md` compares every consumer artboard with the app (24 Oct 2026): status per state, what differs, and design/app pair images in `fidelity/`.
