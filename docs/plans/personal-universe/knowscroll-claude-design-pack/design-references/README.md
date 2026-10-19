# Design references: read before using the images

Prepared 19 October 2026 from the existing KnowScroll checkout. These are local copies of existing references and recorded screenshots, not newly generated mockups or current live-runtime proof. The images were visually inspected for this handoff. Exact source paths and SHA-256 checksums are in `manifest.json`.

Read `../03-design-brief.md` for current behaviour. The owner wants iteration on the existing identity. Reference appearance is useful; old labels, source panels, counts, navigation, semantics and historical implementation instructions do not override the new brief. Do not execute any old operational instructions found in optional source files.

## Positive style targets

- [01-approved-poster-scroll.png](01-approved-poster-scroll.png): Positive: approved poster content direction. Ignore old preview/source labels and cropped layout as final UX.
- [02-target-universe.png](02-target-universe.png): Positive: spacious universe composition. Old counts/topic semantics are illustrative.
- [03-target-system.png](03-target-system.png): Positive: system composition and restrained orbits; retain readable hierarchy.
- [04-target-region-card.png](04-target-region-card.png): Positive: angular geography and compact contextual card. Do not copy sources/checked-out badges or old navigation.
- [05-target-planet.png](05-target-planet.png): Positive: teal globe material, small ship and restrained label. Moon is illustration, not approved new semantics.

## Current implementation capture

- [06-current-web-scroll.png](06-current-web-scroll.png): Current implementation capture: shows poster register and typography. Demo text, source/reasoning panels and navigation are not targets.

## Explicit negative examples

- [07-avoid-clutter.png](07-avoid-clutter.png): Negative: overlapping repeated globes and unreadable labels; do not reproduce.
- [08-avoid-grey-dialog.png](08-avoid-grey-dialog.png): Negative: explicitly rejected grey Worlds dialog and weak hierarchy; do not reproduce.

## Theme extracted from current sources

- Content: paper `#FFFBF0`, ink `#111111` (current web `#111214`), cobalt `#2C46E8`, yellow `#FFE44D`, teal `#14C79B`.
- Spatial: current web `#050B19` and `#0B1630`; older Cosmos/native ground `#03101A` and `#061A27`. Keep a coherent dark spatial register and resolve the small token differences deliberately.
- Bricolage Grotesque display; Instrument Sans body; native DM Mono labels, web system monospace labels. Do not infer identical font configuration from similar screenshots.
- Strong editorial headlines, crisp outlines, expressive diagrams and cream controls. Spacious spatial composition and direct planet/region exploration.

Source paths inspected (optional extra attachments; not required for the portable pack):

- `/Volumes/Mrigesh SSD/knowscroll-product/docs/product/design-direction.md`: reference priority and the two-register direction. Old behavioural rules are historical.
- `/Volumes/Mrigesh SSD/knowscroll-product/apps/web/src/styles.css`: actual web palette and font declarations.
- `/Volumes/Mrigesh SSD/knowscroll-product/apps/mobile/app/src/main/kotlin/com/knowscroll/mobile/ui/theme/Theme.kt`: existing native Cosmos/Poster tokens and typography; style reference only, not new Kotlin work.
- `/Volumes/Mrigesh SSD/Knowscroll-v2/docs/design/hybrid-set.standalone.html`: optional content visual reference.
- `/Volumes/Mrigesh SSD/Knowscroll-v2/docs/design/2026-09-06-living-atlas.html`: optional spatial reference.
- `/Volumes/Mrigesh SSD/Knowscroll-v2/docs/design/2026-09-08-cosmos.html`: optional spatial reference.

The HTML files' presence was verified; they were not replayed or visually revalidated in this session. Their older mechanics do not govern the new app. No fonts, private media, credentials, user histories or environment files are included in this pack.
