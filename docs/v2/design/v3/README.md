# v3 designs

The final designs for the Universe, Scrolls, rooms and Talk, brought in unchanged from the owner's 29 and 30 October 2026 package. CI checks every file against `SHA256SUMS`.

## Authority

All of it is **final** (owner, 29 Oct 2026: "all are final"). On 30 Oct the owner added that the four animation files are final too: "Never change it". `simple-views-finalized.html` says "Do not change". See D-060.

They govern the Universe, Scrolls, rooms and Talk. The v2.1 export (`../KnowScroll-design-v2.1/`) still governs the rest. Where a v3 design changes a rule, the amendment is a numbered decision in `../../decisions.md` (D-060 onward) and the change is in `AGENTS.md`. The blueprint text is not edited.

## How to read the designs

- Every "MY PICK", "My recommendation" and "LEANING" is **decided**.
- Each PDF's "Questions for you to react to" page is a page of decisions.
- When two designs overlap, **the newer one wins**:
  - T3 Talk (29 Oct) beats R3 Rooms (27 Oct). For example, room AI is 2 or 3 named residents, not R3's four assigned roles.
  - The Universe files (28 to 30 Oct) govern anything drawn on the Universe map, including room stations.
  - T3's colour, chrome and look apply to Talk and to rooms.
- The HTML files are prototypes. Their people, messages and worlds are authored examples, never product data. Their code is a reference for the scene builders (`makeSystem`, `makeSun`, `makePlanet`, `genome`, `mapWorld`, the cameras), not code to paste.

## Where the PDFs are

The three PDFs (22 to 34 MB each) are **not** in the repository, which is public. The page images (`pages/*.jpg`) and the text extracts (`*.text.txt`) are. The PDFs are kept at `C:/Users/XZNON/knowscroll-dev/design-v3/` on the build machine: `V3-Scrolls-design.pdf`, `R3-Rooms-design.pdf`, `T3-Talk-design.pdf`.

## Files

| Path | What it is | SHA-256 |
|---|---|---|
| `universe/new-universe.html` | New Universe: foundations, components, 21 screens, five animations, behaviour, rules, build notes | `0a1bdd9e6f40547b097e3b60b5ab2920a2158fd1885d8d680080cd1e03ca34d9` |
| `universe/new-universe.doc-pages.text.txt` | Text of the file above, for grep | `623338afd314e761109cfd188e8f5a155bcf3150950fa994e9bd0eb39eb19923` |
| `universe/world-internals-05.html` | Orbit dial: O1 wheel, O2 system search and filter, O3 dial, O4 planet search | `2b96491a45d81056ddb86c91b439210ee395fe390a29e4d6b2d9bcbccc2a6276` |
| `universe/simple-views-finalized.html` | Simple drawing: two plain lists ("Do not change") | `f6771d61391d63acdb2859b5ee4caddeaa7a77dde1a0eb56eec321bc2700b1f4` |
| `universe/open-finalized.html` | Animation: first open of the Universe tab, once per account | `d2e21883a920f4b2252efc8dac96a1057472fb9181959479f7d41c4e54683da6` |
| `universe/enter-system-finalized.html` | Animation: entering a system by ship (U01 to U02) | `3c085d3a5aaaaa853c54034e72306929f62f72f9f525e83f4f60c1ecc7cc3f24` |
| `universe/enter-planet-finalized.html` | Animation: entering a planet (U02 to U03) | `6dd85c2960f0b31cbd90e7ec45d07d21a56dd543ee55421cb67273eaf7556dfc` |
| `universe/enter-planet-rings-finalized.html` | Animation: entering a planet with rings or a moon (U02 to U03) | `6ba9f94d0e776ba9ffc5d4dee63192b5f618c85aa7c25d15cb0bc3176b4b7fe5` |
| `universe/enter-world-finalized.html` | Animation: entering a world (U03 to U04) | `88c77d7c697bad8252e481e3d2ae88422f630f9f6cd28a633cddf6f25d783045` |
| `scrolls-v3/V3-Scrolls-design.text.txt` | V3 Scrolls (26 Oct): Stage and Spine, Call it, game loops, Ask, endings, `scroll-document.v2` | `d7e423c1bbeba91c7f0a0460859d7243e2634057348a901bdc9126e9ba056b37` |
| `rooms-r3/R3-Rooms-design.text.txt` | R3 Rooms (27 Oct): the room as a campfire, General, topics, Today, AI cast, per-room places, the quiet room | `3294d8b17679a000810b9844cd5a786f07da55c574091a6c5eb2d80016049804` |
| `talk-t3/T3-Talk-design.text.txt` | T3 Talk (29 Oct): Talk in the New Universe look, threads as a trip through a series, residents, scouts, DMs | `ecfba76b95e5925c864a74fa5f4209391e5c4de6599093eb1df8591d4f43735b` |
| `scrolls-v3/pages/` | 11 page images of the V3 PDF | in `SHA256SUMS` |
| `rooms-r3/pages/` | 11 page images of the R3 PDF | in `SHA256SUMS` |
| `talk-t3/pages/` | 7 page images of the T3 PDF | in `SHA256SUMS` |

`SHA256SUMS` lists all 41 files here except this README and itself, in `sha256sum` format. To check: `cd docs/v2/design/v3 && sha256sum --check --quiet SHA256SUMS`.

The change map that turns these designs into work is `../../v3-revamp/CHANGE-MAP.md`.
