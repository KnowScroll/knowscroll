# #116 web system-view evidence

Spec: [docs/product/ui-system.md](../../product/ui-system.md) sections 1-3, 5, 6, 7, and the
Cosmos reference's own system level ([docs/product/references/cosmos.html](../../product/references/cosmos.html)).
Data: `GET /v1/worlds` ([docs/contracts/bootstrap-http.md](../../contracts/bootstrap-http.md),
[ADR-0028](../../decisions/0028-evidence-backed-worlds.md)). Every number in every screenshot below
is a real, database-verified count returned by that endpoint — nothing here is staged text.

## How this was produced

A `knowscroll_demo_116_system_view` PostgreSQL database (this tool refuses any other name — see
`scripts/demo-populate.ts`) was migrated and seeded with the real, unmarked editorial library
(`content/editorial-scrolls.json`, the same three Scrolls `scripts/seed.ts` installs). The tool then
drove two real `GET /v1/feed` → `POST /v1/exposures` calls against the real Fastify app (never a
Keep, never a direct database write): one Scroll from `NASA · Stars` (fully reaching that source's
one Scroll) and one of the two `NASA · Orbits and Kepler's Laws` Scrolls (leaving its second
unreached). This is what makes the two real states below real rather than staged: they are the
honest consequence of *which* Scrolls were exposed, not a hand-picked label.

```
DATABASE_URL="postgresql://.../knowscroll_demo_116_system_view" pnpm exec tsx scripts/demo-populate.ts
```

A real API (`apps/api/src/main.ts`) and a real Vite dev server (`apps/web`) were then started against
that database (the same dev-auth-proxy path `scripts/run-web-reader-journey.ts` already uses), and a
real Chromium browser (Playwright, already a devDependency of `apps/web`) navigated the running app:
Universe → "View your system" → the system view. The Cosmos reference file was opened directly by the
same browser (`file://.../docs/product/references/cosmos.html`), driven to `day 30` and its `system`
flow level, and its `#phone` element (the actual product-UI mock, not the surrounding marketing page)
was screenshotted the same way. The disposable database was migrated, used, and dropped; nothing here
touches the owner database or any other lane.

The honest-empty screenshot (`system-view-empty-1440x900.png`) is a second, genuinely empty database
with no assets and no exposures at all — `GET /v1/worlds` there returns `system: null`, and the
screenshot is the actual first-load rendering of that response, not a mocked component.

## Reproduce

```
pnpm --filter web typecheck
pnpm --filter web test
pnpm typecheck
pnpm test
pnpm tsx scripts/run-web-reader-journey.ts
```

The screenshots themselves were captured by two throwaway orchestration scripts (start API+web against
a disposable database, drive Chromium, screenshot, tear down) written for this evidence pass and
deleted afterwards — they are not part of the repository; `scripts/demo-populate.ts` is what remains,
since the brief asked for it explicitly.

## Screenshots (`screenshots/`)

| File | What it shows |
|---|---|
| `universe-{size}.png` | Universe, honest empty (no Scroll ever Kept in this demo — only exposed), with the new "View your system" control next to Enter Scroll. |
| `system-view-{size}.png` | **The deliverable.** Our built system view: head band (`‹ Universe` back pill, "Derived from recorded sources, never inferred", `SYSTEM` kind label), a real subtitle ("2 WORLDS · 3 SCROLLS RECORDED · 2 SEEN"), a centre, one orbit ring, and one body per real world with its real `sourceTitle` and mono status (`2 SCROLLS · 1 SEEN` / `1 SCROLL · 1 SEEN`), a real Open-source link per world, and a distinct tag/treatment for `MORE TO EXPLORE` (Orbits: 1 of 2 reached) versus `FULLY EXPLORED` (Stars: 1 of 1 reached). |
| `system-view-reduced-motion-{size}.png` | Same real data with `prefers-reduced-motion: reduce` emulated. The only motion this view has (the sun's opacity pulse) is gated the same way `CosmosBackground`'s twinkle already is; state is otherwise identical, instantly. |
| `system-view-empty-1440x900.png` | The honest empty state against a database with zero exposures: `system: null` rendered as "Nothing has been encountered yet... there is no system yet because nothing has been encountered," never an invented or empty-looking system. |
| `cosmos-reference-system-day30-{size}.png` | The Cosmos reference's own system level (`#L1`), `day 30` stage, cropped to its `#phone` mock — for the side-by-side fidelity check ui-system.md sec.7 asks for. |

Both sizes required by ui-system.md sec.7 are included (1440×900 and 1024×768), though the brief only
asked for 1440×900 explicitly.

## Reading the two side by side

The reference (`cosmos-reference-system-day30-*.png`) is a **phone-sized mock** (Cosmos's own fixed
384×812 `.phone` element): a title/subtitle head, a glowing sun, elliptical orbit rings, planets with
a name and a mono status (`READY TO IGNITE`), a station, a nebula (`?????`), a `⌖ RECENTER` pill, a
`‹ universe` back pill, a hint line, and a bottom dock (Cable/Atlas/Ask/Keep tabs). Our build
(`system-view-*.png`) is this product's actual **desktop web surface** (ADR-0022): the same palette,
pill geometry, mono micro-labels and centred-stage/head-band structure already established for
Universe and the Scroll reader in `docs/journeys/evidence/web-ui` (#107/#110) — Cosmos wins on look,
Living Observatory/this app's own established desktop structure wins on layout, exactly as
ui-system.md's opening line states. What matches: the sun-and-orbit geography, planet-with-name-and-
mono-status-label grammar, pill shapes/colours, and the `‹ universe` back control.

## What was deliberately not drawn, and why

- **No nebula.** The reference's nebula stands for "what you have not surveyed" — real narrative
  content in that prototype's own mock data. `GET /v1/worlds` never tells this client about a world
  it has *not* encountered (by ADR-0028's own guard, `world_system_member.seen_count >= 1`, a world
  is either a real member with a real count or simply absent — never an empty placeholder). Drawing a
  nebula would mean inventing "there is more out there," which is exactly the kind of decoration
  ui-system.md sec.6 forbids ("a node that implies meaning is not" decorative).
- **No station, no "Lately" pill, no black hole.** None of friends/rooms, a change-log surface, or
  unanswered questions exist in this product yet (ui-system.md sec.6's explicit "not available,
  therefore not drawn" list: rooms, inhabitants, friends).
- **No multiple orbit rings ranked by "attention."** The reference places a planet's ring by a real
  attention count in its own mock; this build has no analogous per-world ranking signal to place a
  world honestly closer or farther from the centre, so every world sits on the one real ring,
  positioned only by the order the API returned — decorative, never implying a rank the data does not
  support.
- **No drag-to-pan/pinch-to-zoom camera.** The reference's system is a manipulable camera over a
  simulated space; ours is a fixed, small (currently at most a handful of worlds) real list with no
  need for one yet. Nothing here was cut for time; there is simply no real interaction it would serve.
- **No literal Cable/Ask/Keep bottom dock.** Those three destinations do not exist as real, working
  surfaces in this product (Ask has no mobile/web control per ADR-0016; Cable/rooms do not exist at
  all yet) — a non-functional tab bar would be exactly the kind of "unavailable Ask/Friends/Reel
  button as a fake working feature" the bootstrap contract explicitly forbids. The persistent bottom
  line this view actually carries (`Keyboard: Escape or Home returns to Universe.`) reuses the same
  `.keyboard-help` footer already established on the Scroll reader.
- **`READY TO IGNITE`-style anticipatory labels.** Invented meaning about what a world is "about to
  become" has no real signal behind it here; the two labels this view actually shows (`FULLY
  EXPLORED` / `MORE TO EXPLORE`) are a direct, literal comparison of two real counts the API already
  returns (`seenCount` vs `scrollCount`), nothing more.

## The one interpretive call this view makes, named explicitly

ADR-0028 guarantees every world `GET /v1/worlds` returns already has `seenCount >= 1` (a `world` only
becomes a `world_system` member once this universe's own exposures have reached it at all) — so "a
world with nothing seen yet" can never literally appear in this response. The brief's requested
"distinct treatment for a world with nothing seen yet versus one the reader has been into" is
therefore read here as the nearest honest, database-verified distinction the two real counts actually
support: **has this reader's exposure history reached every recorded Scroll behind this world
(`FULLY EXPLORED`, `seenCount >= scrollCount`), or is there real, counted more to it
(`MORE TO EXPLORE`, `seenCount < scrollCount`).** The genuinely-nothing-encountered case is instead
drawn at the whole-system level (`system: null`, the honest empty state above), which is the only
place that real absence can actually occur. This interpretation is disclosed here for the coordinator
to confirm or correct, not asserted as the only possible reading.

## What remains unproved

- No automated pixel-diff against the reference was run — fidelity here, like the #107 evidence
  before it, was judged by eye against the reference file and ui-system.md's extracted values.
- The `1024×768` cosmos-reference screenshot crops the same fixed 384×812 `.phone` element regardless
  of the outer viewport size (the reference's own mock does not itself resize), so the two
  `cosmos-reference-system-day30-*.png` files are pixel-identical; kept at both sizes only for the
  side-by-side pairing with our own two real, differently-laid-out sizes.
- This is a **fixture/demo proof, not live product acceptance**: `knowscroll_demo_116_system_view`
  and its `_empty` counterpart were disposable databases created and dropped for this evidence pass
  only; nothing here is owner history, and no claim is made that this is what the owner's own universe
  currently shows (see `docs/CHECKPOINT.md` for that account's real state).
- Only 1–2 real worlds were exercised end to end (the seeded library's real two-source shape). Layout
  at a larger world count (many bodies on one ring) was not separately verified against overlap; the
  positioning is decorative and documented as such above, but has not been visually checked past this
  count.
