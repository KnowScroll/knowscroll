# The Universe screen

What a person has read, shown as places: regions on planets, planets round stars (systems), and rooms as stations beside their star. This folder is the screen for your own Universe (`universe-screen.tsx`, the route `app/(tabs)/universe.tsx`). A friend's Universe (`features/visit/`) mounts the same surface over a session of its own. The behaviour list, routes and decisions are in `apps/client/README.md`; this file is the map of the folder.

## How a place becomes something drawn

1. **The session** (`universe-session.ts`, made per account by `use-universe-session.ts`) reads the person's scene from the server through `@knowscroll/client-core`: the sky, the manifest, chunks of systems and planets, geography. The server places everything once; nothing here moves a place. The session also holds where you are: `focusId` (nothing, a system, a planet or a region), `landed`, and `frame` (a pan or turn in screen points).
2. **The layout** (`universe-layout.ts`, `universe-places.ts`) turns the session's state into a view (`UniverseView`: the whole universe, a system, a planet) and an index of places.
3. **The surface** (`universe-surface.tsx`) is the chrome over the drawing: the header and Back pill, the region card, Lately, the list (`dial/` on a phone, Browse on a desktop), search, sheets. It picks the stage.
4. **The stage** draws the view:
   - `universe-stage.tsx`: the map as it ships, the 3D map and system (`space/`, three.js written by hand), a planet's globe and landed map as SVG (`planet/`), and the animated steps between them (`animation/`).
   - `voyage/`: the Round 7.3 look on trial, behind "Try the new Universe" (`universe-trial.ts`). One camera flies along a ladder of stops over the same three.js scene; a planet is one textured sphere from orbit to the ground; a ship the person can drag. See "The ladder" below.
   - `crossing/`: the film of the crossing to a friend's Universe (Round 7.3): one pure function of film time (`crossing-frame.ts`), one fragment shader in a lazily loaded three.js pass, and the 2D marks over it. Frames only, not wired into a visit yet; seen only at `/gallery-space?scene=crossing&q=0.30` (see "Looking at it locally").
   - `simple/`: the plain lists, when 3D is off (Simple drawing), fails, or the device is short of memory. Always kept: it is also how a screen reader reaches every place.
5. **Taps are buttons, not raycasts.** Every place on screen is a named button of at least 48 points laid over the canvas at the place's projected point; the canvas is hidden from assistive technology. Land not reached yet is drawn grey and is never named, counted, tapped or read out.

## The ladder (the trial look)

`voyage/ladder.ts` holds the stops (`'universe' | 'star' | 'planet' | 'ground'`), what each stop shows (`STOPS`) and how a view maps onto one (`stopOf`, `targetOf`). The stored camera did not change: the stop follows from `focusId` and `landed`.

The camera driver (`voyage-driver.ts`) is loaded on demand with three.js (`voyage-loader.ts`). Its parts:

- `voyage-chains.ts` (pure): for a target, a chain of links, one per place it is in (planet, star, the whole universe), each a point and a distance.
- `flight.ts` (pure): how a flight moves between two chains.
- `voyage-view.ts`: which way the camera looks and where it stands.
- `planet-close-up.ts`: the planet as one world (`globe.ts`, painted by `world-texture.ts`), with a sharp patch of the map round the place you land.
- `ship-motion.ts` (pure) and `ship-layer.ts`: the ship.
- `station-look.ts` (pure) and `station-layer.tsx`: a room's station, drawn flat over the canvas at its anchor in place of the scene's own mesh (`showStations`, called by the driver on attach), with the prototype's lights, glow and hover.

Search: the Back row of a star, a planet and its ground carries a small search circle (`universe-header.tsx`), and while the card is open the stage draws the sky's answer (`search-sky.tsx`): a dim, with a glow and a ring on each system the card reports as holding a match (`universe-search.ts` `systemsOfResults`, handed up by the card's `onLit`). The screen skips its flat dim in this look. `search-sky.tsx` is drawn from the overlay's anchors, over the canvas and under the buttons' touches.

Search: the Back row of a star, a planet and its ground carries a small search circle (`universe-header.tsx`), and while the card is open the stage draws the sky's answer (`search-sky.tsx`): a dim, with a glow and a ring on each system the card reports as holding a match (`universe-search.ts` `systemsOfResults`, handed up by the card's `onLit`). The screen skips its flat dim in this look. `search-sky.tsx` is drawn from the overlay's anchors, over the canvas and under the buttons' touches.

The stage (`voyage-stage.tsx`) and its controller (`voyage-controller.ts`, gestures and the ship, outside React) reach the main bundle, so they never import three.js; `voyage-control.ts` is the typed channel between them and the driver. The controller's pure parts: `stage-touches.ts` (what the fingers mean, each followed by its id), `pinch-gesture.ts` (a pinch that follows the fingers and moves one stop) and `flight-legs.ts` (each flight timed for the frame-rate readout).

**Sizes.** The new look has no board of its own for a tablet: the product's breakpoints decide (`useDisplay`, 1024 px). A tablet (600 to 1023) takes the phone layout beside the shell's rail; from 1024 px the desktop one. Only the desktop changes the look, and only through what `UniverseSurface` hands down: `desktop` (the ship parks at 0.8 of the height, leans from 0.6 and may go from y 70 to H - 60: `SHIP_LAYOUT` in `voyage-controller.ts`, the prototype's `DESK` numbers), key hints that name the keys the new look listens to (`KeyHints`, a column bottom right), and no zoom buttons (`+` and `-` move one stop, as the wheel and Back do). The planet's caption (phone and tablet layouts) stands under the globe (`captionBelowGlobe`: the globe's bottom edge as the camera places it, plus the prototype's 30, never above 0.62 of the height, which is where it stood on a 390 x 844 phone). That reads the camera; nothing here moves it. The frame-rate readout, in this look, stands in the column under the header (`FrameRateFigure`), so it covers none of the header at any size; the old look keeps its corner. **Known gaps:** on the smallest phone (320 x 568) the chips and a notice leave the caption no room under the globe, so it stands on the chips as ever and meets the globe (a fix needs the camera to hold a smaller globe on a short screen, which a trial of this size did not take on: an attempt jumped the camera when the chips changed); not built: the prototype's rail and its search card at the left, `AY = 0.5 H` for every stop on a desktop, and moving the ship by keyboard (the controller has no such key; every other gesture has one).

**Adding a level** (a galaxy between the whole universe and a star): one more member of `Stop` and one row of `STOPS`; one more link in `chainOf`, after the star's and before the universe's (the camera reads a planet's chain as the planet's link, then the star's, whatever follows); `targetOf` and `stopOf` for the view that opens it; and the session's kind of place. A level with no data yet (a universe with no galaxy) is simply absent from a chain.

**Maps of a planet: built, shown only in the gallery until wired.** `voyage/maps/` holds the two maps the ground will open (Round 7.3): `PlanetMapScreen`, the whole planet as a flat SVG of the ground's own world with the formed regions named in colour, land not reached as ONE grey path with no name, count or press (D-109), and the list of formed regions under it ("4 regions", never "N of M"); and `RegionMapScreen`, the same drawing cropped, seam-aware, round one region, with the region's next Scroll or Reel and its other format with Open. Both are self-contained screens that take the planet, its formed regions, the looks and callbacks as props and read nothing, so wiring them to the session later does not change them; they are seen only at `/gallery-space?scene=maps` (see "Looking at it locally"). `use-flat-planet.ts` and `use-region-encounter.ts` copy `usePlanetSurface` and the old region card's Open logic on purpose, so the files other work owns stay untouched.

## What is kept on the device

Per account and privacy epoch, purged with it: `universe.view.v1` (where you were, Lately, Simple drawing, the last place; `universe-memory.ts`), `universe.here.v1` (`universe-here-marker.ts`) and `universe.landmark-seen.v1` (`collection/`). The Back history (32 steps) lives in memory. Returning from a Reel or Scroll uses a `scene-return.v1` locator (`universe-camera.ts`), a wire schema shared with the server: what it holds must fit its bounds. Looking at the map writes no evidence and sends no write.

## Speed

The frame loop (`space/space-view.tsx`, `space/render-loop.ts`) draws at most one frame every 33 ms, at a pixel ratio of at most 1.5 (D-073), and stops when the screen is not in front. With "Show the Universe frame rate" on, `frame-rate/` shows the frame rate over the canvas (developer use, removed when the trial ends). A scene rebuilt from scratch frees every shader program and links it again; the trial avoids that during flights (see `apps/client/README.md`, "No stall from a rebuilt scene").

## Looking at it locally

Build the web export and the developer gallery (`pnpm --filter @knowscroll/client build` and `build:gallery`; a new worktree first needs `pnpm --filter "@knowscroll/client^..." build`). The gallery page `/gallery-space?scene=voyage` draws the trial look over labelled sample places, with no account. `/gallery-space?scene=crossing&q=0.30&dir=out&name=Ravi&shared=Attention,Stars` draws one still of the crossing at film time `q` (`&play=1` plays it). `/gallery-space?scene=maps` draws the two maps over labelled sample data: `map=1|2`, `regions=1..12` (how many have formed), `seam=1` (a region across the band's seam; on map 2 it is the one shown), `here=1` ("you were here"), `preview=scroll|reel|loading|offline|unavailable|blocked` (map 2), `hypothetical=1` and `type=lush|ocean|frozen|scorched|barren|gas`; choosing a region on map 1 opens its map and Back returns. The browser specs open `/universe` over authored fixtures (`universe.fixture.ts`, `e2e/voyage-fixture.ts`).

## Tests

- Unit tests sit beside the code (`*.test.ts(x)`, Jest): the session, the layout, the camera maths, the flight, the painter (its pixels are pinned by hash), the driver over a real scene without a GPU.
- Browser specs (`apps/client/e2e/universe-*.spec.ts`, Playwright, headless Chromium with software WebGL) find places by button name, count frames and read pixels from screenshots. They never wait for a moment inside an animation, and assert no frame rate: software WebGL is not a phone.
- `space/fake-space-gpu.ts` stands in for WebGL in screen tests.
