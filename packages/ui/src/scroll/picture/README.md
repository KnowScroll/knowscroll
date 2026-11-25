# Pictures of a document v3

One renderer draws every picture of a `scroll-document.v3` (#762, D-432). A picture is data from the closed set of
kinds in `packages/scroll-model/src/v3/pictures.ts`; this folder turns it into a drawing. No kit is involved: the v2 drawing
kits are all deleted (#835), and this is the only renderer of a Scroll's figure.

Status: **implemented**, unit-tested and browser-tested in the gallery (`folio-v3-smoke.spec.ts`). Web only, like
Folio (#740).

## How a picture is drawn

| Step             | Where                                        | What it does                                                                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lay out          | `layout/<kind>.ts`, `layout/index.ts`        | A pure function of the picture, its state and the box: plain shapes (rect, circle, line, arc, text) in the box's own pixels, each with a stable `key`, the part it draws and a colour **role**. The caption takes two lines (three at 9 px) at the foot.                                                             |
| Draw             | `picture-svg.tsx`                            | The shapes as SVG, roles turned into colours (`palette.ts`). A pulsed part that is visible is drawn at full strength in the `mark` colour, as a stroke of at least 2 px (a shape with no stroke gets one) or, for text, the `mark` fill; a part not yet reached stays hidden. Decorative to assistive tech. |
| Move             | `blend.ts`, `use-stage-pictures.ts` | Two scenes of one picture in one box glide: shapes are matched by key, those leaving fade out and those arriving fade in. Anything else, and every change under reduced motion, cross-fades.                                                                                                                |
| Measure and name | `picture-figure.tsx` (`PictureDrawing`)      | Measures its box, lays out for it, and names the image with `describePicture` from scroll-model, which is also its text version.                                                                                                                                                                            |

## The kinds

| Kind      | Draws                                                                                         | State keys              |
| --------- | --------------------------------------------------------------------------------------------- | ----------------------- |
| statement | one number large, one quotation with who said it, or a short list                             | `lit`                   |
| flow      | steps with arrows, in one row, a snake of rows or a column, whichever gives the largest steps | `upTo`, `lit`           |
| cycle     | items on a ring with arrows, labels outside, an optional centre                               | `upTo`, `lit`           |
| grid      | cells under row and column headings; a `large` cell outweighs the rest                        | `upTo` (rows), `lit`    |
| chart     | bars or a line of cited values, marks, values printed or not                                  | `upTo`, `lit`           |
| plan      | a schematic plan: ways, places, tallies by step, a "nearest to" region, routes                | `step`, `lit`, `region` |

Every layout keeps every shape inside the box and no text over another text at 320 × 190, 390 × 287, 560 × 380 and
360 × 140, at text scale 1 and 2 (the layout tests check it). Items not yet reached by `upTo` or `step` stay in the
scene at opacity 0, so a later state fades them in where they stand.

## Colours

Page roles (`ink`, `ink2`, `rule`, `ground`, `raised`) follow the page's appearance. The meaning roles keep one value in
both appearances and reach 3:1 on both plates and grounds: `warm` `#C75B12`, `cool` `#3F78D6`; `mark` is the page's link
colour, so a linked phrase and its part match. Nothing mixes colours (D-424). A part that is not the subject is given
60 % opacity by its layout (`RECEDED`); the drawing keeps that for shapes, but draws a receded **text** at 85 %
(`RECEDED_TEXT`, a continuous bend of the opacity that keeps 0 and 1), so `ink` and `ink2` labels keep 4.5:1 on both
plates (a test computes it). Cell borders of a grid are `ink2`, which reaches 3:1 on both plates; `rule` is a hairline
that does not, so no border that must be seen uses it. Captions and step names are mono, whose width is estimated per
character (`MONO_ADVANCE`), and a caption steps down to 9 px to keep to two lines (three at 9 px).

## Adding a kind

Add its data and state keys in scroll-model (`pictures.ts`, `picture-rules.ts`, `describe.ts`), a layout file here and
its case in `layout/index.ts`, and the layout tests at the four sizes and two text scales. Runtime names from
scroll-model come through `../model.ts` (and the allow-list in `../prepare.test.ts`), so Zod is configured first.
