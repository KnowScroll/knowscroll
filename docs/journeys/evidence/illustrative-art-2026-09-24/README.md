# Decorative Places art is labelled — 2026-09-24 (#131)

#131 requires that decorative moons and geography never imply verified knowledge. On the Places
layer every planet is drawn on an orbit ring with a moon and land shapes, and zooming into a planet
(the continents level) shows authored continents, an ocean current and clouds; none of it is data. Its label used to say only that
positions are illustrative. It now says: "Positions, orbits, moons and land art are illustrative —
what's mapped and how it connects is real." (The review asked for the orbit rings and all land art,
not only land shapes, to be named.) The Sources layer keeps its own "Orbits & moons are
illustrative".

Evidence: `PlacesScreenTest` (updated first; failed; then passed), Android units and lint, and the
emulator `places` journey passing with the new line on screen (`places-system.png`). The owner's
preview was restored and verified.
