# Scene core

Canonical `scene-descriptor.v1`, `scene-chunk.v1`, `scene-manifest.v1` and
`scene-return.v1` data, strict guards and `silhouette.v1` numeric geometry for
server, browser and React Native. No runtime dependencies, browser globals,
DOM, React, I/O, random state, clocks, executable templates or Zod configuration.

This is a prerequisite for #238. It implements neither the scene projection
worker nor the Universe renderer, formation eligibility or formation-shown
acknowledgements. CI fixtures are synthetic, not product geography. The v2.1
U01–U05/U07/U08 source designs guide the future consumer; their sample worlds
are not imported here.

## Public API

Each `*Schema` offers `parse(unknown)`, `safeParse(unknown)` and
`parseJson(string)`. These are small manual guards, **not Zod schemas**. Future
wire adapters should call them explicitly instead of copying schema rules.
All objects are strict: unsupported versions, extra keys, URLs/code, functions,
accessors, non-finite numbers, invalid IDs and excessive structures are refused.
Errors are generic and never echo input. Parsing returns fresh JSON data.
Use `parseJson` directly on untrusted transport: it checks the UTF-8 byte cap
before native JSON parsing. Object parsing accepts ordinary JSON data only;
JavaScript Proxies are outside the transport contract. No getter, `toJSON` or
function contained in ordinary input is called.

```ts
import { SceneChunkSchema, buildSceneGeometry } from '@knowscroll/scene-core';

const chunk = SceneChunkSchema.parseJson(receivedChunkJson);
const geometry = chunk.objects.map((object) =>
  buildSceneGeometry(object, { detail: 'low', reducedMotion: true }),
);
```

The projector supplies existing stable object, parent and origin-transition IDs,
labels, factual/hypothetical status, explicit family/template, opaque 32-hex seed
and persisted layout anchors. `terraced.v1`, `ridged.v1` and `archipelago.v1`
are visual templates; the projector selects a family from meaning **before**
applying seed variation. This library has no topic classifier, user hash or
formation rule. Do not treat a seed as semantic classification. Never rebuild
anchors from a changing sibling index. Existing descriptors retain their pinned
generator version; unsupported versions fail for an honest unavailable/fallback
consumer state rather than silently regenerating a different world.

Geometry includes bounded numeric vertices, fixed family size, palette/material,
atmosphere radius and unchanged semantic identity/navigation targets. A renderer
can construct SVG paths from these numeric points; arbitrary SVG, URLs, scripts
or model code cannot enter a descriptor. Full detail has 64 points; low detail
has the same 16 anchor vertices (each fourth full point). Reduced motion changes
only the decorative motion hint. Activity is either explicitly available
(active/quiet) or unavailable; it never affects shape, size, existence or routing.
The renderer owns animation and accessible controls/outline and must retain the
hypothetical framing. No frame loop or model call is needed.

Chunk references contain only IDs/revisions, not fetch URLs. A manifest can be
empty and a chunk can contain zero objects; parsing never creates a placeholder
planet. Geography, structure, activity and scene revisions are separate watermarks, with no
artificial equality or ordering across independent domains. `personalRevision` is the
personal-root watermark read with the Geography input used by this projection. It is
not a Personal Context projection revision or the current root watermark; within the
same scope it cannot exceed the current root watermark.
A chunk reference's scene revision belongs to that immutable chunk. Local parent
hierarchy and duplicate identity are guarded; parents and route endpoints may
live in another permitted chunk. The projector must validate cross-chunk
consistency and current access. A manifest/read grants no authority itself.

`SceneReturnLocatorSchema` preserves exact bounded frame coordinates, scale,
chunk and optional object focus for caller-owned navigation. It is metadata,
not a camera implementation, encounter resume record, durable receipt or
formation acknowledgement. Consumers must fence cached private scenes and
return locators by their existing account/epoch resource scope.

## Look data (U-1)

Status: implemented and unit-tested; not yet drawn by any screen. Related: #465, D-102, D-103.

`SceneLookSchema` parses `scene-look.v1`, the persisted look of one object: a system's `haze` (one of
`HAZE_FAMILIES`), a planet's `type` (one of `PLANET_TYPES`), `rings`, `moon`, whole-degree `hueShift`,
`variant` and `siteCount`, or a region's `site`. It pins generator `worldmap.v1`
(`WORLD_GENERATOR_VERSION`) and, like the descriptor parser, is strict: it refuses extra fields, so no
activity, count or time can ride on a look. `SceneLookJsonSchema` documents its structure.

`seededUnit(seed, channel)` is the one pinned source of seeded numbers: the same integer mixing as
`silhouette.v1`, shared by the server (which stores what it decides) and by a client generator (which
derives layout from the planet's seed and the look). Channels 0 and 1 are the silhouette's; look rules
use 16 and above.

## World generator (U-4, `worldmap.v1`)

Status: implemented and unit-tested; drawn by the Universe's planet globe (U03) and landed map (U04).
Not run on Hermes or a phone. Related: #468, D-108, D-109.

`buildGlobe(spec)` and `buildMap(spec)` lay out one planet's world from `{ seed, type, variant, siteCount }`
(a planet look, D-102) and nothing else: **which regions have formed is not an input**, so a cell keeps its
shape, and its name's place, when a region forms. The globe is a 480-unit band that wraps without a seam;
the map is 390 by 844 units. Both cut the same sites in the same order: one cell for each site, in site
order, plus one to three decorative continents that belong to no site.

`chartWorld(world, regions)` says which land is a formed region. A formed region gets its cell and a place
for its name (`charted`). Everything else is `unreached`: outlines and a cloud, with no id, site, name or
count, mixed so that its pieces are never as many as the unformed sites (D-109). A region whose site is out
of range or already held has no cell. Every cell and every decorative continent has more than `MIN_CELL_AREA`
(150 square units) of land: where noise left less, `island.ts` stamps a small round island on the seed point,
from the pinned unit circle, and the island joins the coast (D-108).

**Pinned maths.** Only exact arithmetic (add, subtract, multiply, divide), `Math.floor`, `Math.round`,
`Math.sqrt` and `Math.imul`: no `Math.sin`, `Math.cos`, `Math.pow`, `Math.hypot`, `**`, clock or random
state. Streams are FNV and Mulberry32 (`random.ts`), noise is gradient noise on a seeded permutation that
wraps by whole lattice cells (`noise.ts`), turning uses the 64-sample unit circle of `silhouette.v1`
(`unit-circle.ts`), outlines are marching squares (`contours.ts`) rounded to a tenth of a unit. A test
refuses banned maths in these sources and pins the output of three planets by digest and by literal
coordinates. A change to any constant, size, channel or draw order is a new generator version.

| Capability                                                        | Status                               |
| ----------------------------------------------------------------- | ------------------------------------ |
| Globe and map worlds from a look; same sites in both              | implemented                          |
| Adding a region leaves every other border and name bit-identical  | implemented (unit test, many seeds)  |
| Unreached land as outlines only; never the unformed count         | implemented                          |
| The same numbers on Hermes as in V8                               | planned (pure arithmetic; no device run) |
| Land at every site, up to the cap of 32 sites                      | implemented (unit test, 2,400 planets) |

## Bounds and verification

`SCENE_LIMITS` caps wire input at 262,144 UTF-8 bytes, object-input UTF-8/JSON-escape
accounting with conservative delimiter overhead at the same ceiling, depth 12, 12,000 nodes, 100 objects
and 100 routes per chunk, and 128 chunk references per manifest. These are
transport/render bounds, never consumption thresholds. The fixed generator
uses integer seed mixing, a pinned 64-sample unit circle and rounded numeric
geometry; no runtime trigonometric functions can vary across engines. All family outputs are
finite and bounded; stored anchors are bounded to ±10,000 and scale to
0.125–16. No global parser/compiler setting is changed.

`pnpm build` and `pnpm typecheck` collect this package recursively. The unchanged
Actions `backend` job has a separate scene-core unit step; existing Scroll
isolated timing and backend/PostgreSQL test lanes remain intact. Tests cover
identity/anchor stability after unrelated arrivals, family/seed variation,
strict bounds/refusal, exact returns, finite generation, input ownership,
empty scenes, independent activity/framing and CSP. Automated suites run only
in GitHub Actions, as required by AGENTS.md.

## Structural wire documentation

The public `SceneDescriptorJsonSchema`, `SceneChunkJsonSchema`, `SceneManifestJsonSchema`
and `SceneReturnLocatorJsonSchema` describe the JSON structure for OpenAPI consumers.
They stay here beside the canonical parsers, without runtime dependencies. They are
documentation, not a replacement validator: cross-field identity, hierarchy, unique
object/chunk/route identities, label safety, total UTF-8/escape-byte/node/depth limits
and hostile host-object refusal remain parser authority. Wire adapters delegate to
`safeParse` and attach this metadata through their documented schema converter API.
