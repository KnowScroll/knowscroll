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
planet. Geography, structure, activity, scene and personal revisions are separate
watermarks, with no artificial equality or ordering across independent domains.
A chunk reference's scene revision belongs to that immutable chunk. Local parent
hierarchy and duplicate identity are guarded; parents and route endpoints may
live in another permitted chunk. The projector must validate cross-chunk
consistency and current access. A manifest/read grants no authority itself.

`SceneReturnLocatorSchema` preserves exact bounded frame coordinates, scale,
chunk and optional object focus for caller-owned navigation. It is metadata,
not a camera implementation, encounter resume record, durable receipt or
formation acknowledgement. Consumers must fence cached private scenes and
return locators by their existing account/epoch resource scope.

## Bounds and verification

`SCENE_LIMITS` caps wire input at 262,144 UTF-8 bytes, object-input conservative
JSON escape accounting at the same ceiling, depth 12, 12,000 nodes, 100 objects
and 100 routes per chunk, and 128 chunk references per manifest. These are
transport/render bounds, never consumption thresholds. The fixed generator
uses integer seed mixing and rounded numeric geometry. All family outputs are
finite and bounded; stored anchors are bounded to ±10,000 and scale to
0.125–16. No global parser/compiler setting is changed.

`pnpm build` and `pnpm typecheck` collect this package recursively. The unchanged
Actions `backend` job has a separate scene-core unit step; existing Scroll
isolated timing and backend/PostgreSQL test lanes remain intact. Tests cover
identity/anchor stability after unrelated arrivals, family/seed variation,
strict bounds/refusal, exact returns, finite generation, input ownership,
empty scenes, independent activity/framing and CSP. Automated suites run only
in GitHub Actions, as required by AGENTS.md.
