# KnowScroll v2.1 design export: consumer screens discovery

Read-only discovery of the v2.1 design export (`/Volumes/Mrigesh SSD/knowscroll-dev/v2/design-reference/KnowScroll-design-v2.1/`), checked against the architecture in `72-personal-universe-architecture/docs/plans/personal-universe/02d-greenfield-blueprint.md` sections 7, 17 and 18 and `03-design-brief.md`. Written 2026-10-19.

**Ground rules for reading this file**

- Every person, message, topic and world in the export is authored example data (Asha, Ravi, Meera, black holes, attention, inference). None of it is product data. The artboards carry a "Prototype · design data" badge.
- The **blueprint governs behaviour**; **v2.1 governs visuals**. Where they disagree, this file flags it and proposes a resolution.
- Each artboard is one canvas board containing several 390×844 phone frames (`div.phone`, light content register, or `div.phone.sp`, dark spatial register), a caption per frame (`figcaption.cap`: `<b>` frame label + `<span>` sub-caption) and six annotation notes underneath (`section.notes > div.note`: Route & origin, Actions, States & overlays, Commands · observations, Restore, Accessibility & platform). The note text is the designer's own spec. It is quoted here where it is load-bearing. The command names in the notes (for example `thread.continue{series|related}`) are design-side names, not blueprint routes. This file maps each one to a blueprint route.
- Desktop frames for consumer screens live on D01–D05 and V01, which another agent covers. Per artboard this file names the desktop rule the coverage index states.
- Renders: full board at `design-reference/renders/<ID>.png` (DSF 1), one crop per phone frame at `design-reference/renders/crops/<ID>-NN.png` (DSF 2, NN = frame order left to right). They are rendered with Chromium 1228 from the static `html/*.html`, with the Google Fonts loaded (Bricolage Grotesque, Instrument Sans and DM Mono were all confirmed loaded).

Shared chrome seen on most frames (named once here):

- **NavBar** (`div.navslot > nav[aria-label=Primary]`): four buttons **Explore · Universe · Talk · Keep**. It is a dark pill, the active tab is cobalt, and it uses `aria-current="page"`. It hides while reading or playing and returns at boundaries.
- **Format switch** (`div.seg[role=group][aria-label="Format of this explanation"]`): two `button[aria-pressed]` items, **Reel** and **Scroll**. It is equal-status and sits in the same top-right place on both formats.
- **Action rail / strip** (`div.ra` vertical on Reel; `div.strip` horizontal pill on Scroll): `ibtn` **Like** · **Save/Saved** (yellow fill when pressed) · **Share** · **Ask about this**.
- **Tags** (`span.tag`): plain topic tag; `.tag.part` (yellow, "Part 2"); `.tag.hyp` (cobalt dashed, "Hypothetical"); `.tag.cor` (rust, "Corrected"); `.tag.ai` (ink, AI label); `.tag.sp` (on dark).
- **Buttons**: `.btn` (outlined with a 3px offset ink shadow), `.btn.pri` (cobalt), `.btn.ink`, `.btn.ghost`, `.btn.sp` (cream on space), `.btn.sm`; `.ibtn` 48px circular icon button.
- **Banner** (`div.banner`): an inline notice with an icon (info/offline/error variants).

---

## A01–A03 · Entry, recovery, first arrival

- **Board:** 2174×1480. Five phone frames (390×844), with no desktop frame on this board. Desktop rule: a centred 480px card on the space ground (V01).
- **Purpose:** easy account access with no interest survey; recovery from an expired session or a dead link that always returns to the held destination; and a first arrival that drops straight into a playing Reel with one dismissible gesture hint. The universe starts empty ("Your universe starts quiet").

**Frames / states drawn**

1. **A01 · Sign in** (`phone.sp`, dark spatial ground with one calm star and a hairline orbit). Wordmark "KnowScroll", tagline "Thoughtful Reels and Scrolls. A universe that grows from what you explore." Buttons: `btn.sp` **Continue with email**, `btn.ghost` **I have a sign-in link**, and a disabled dashed placeholder **[Other sign-in options — to decide]**. Footer: "No questions to answer first. Your universe starts quiet."
2. **A01 · Link sent**: Back `ibtn`, envelope illustration, "Check your inbox / We sent a sign-in link to **asha@example.com**. Open it on this device to continue." Banner: "The link works once and expires after a short while. If it stops working, ask for a new one." **Resend the link**, **Use a different email**.
3. **A02 · Session expired**: `tag` "Signed out" (lock glyph), "You were signed out / It's been a while on this device. Sign in again and you'll return to the Scroll you were reading." A held-destination card with a cobalt offset shadow: "YOU'LL RETURN TO" · `tag` "Scroll · 6 min" · **Attention, slowly** · "At 'Why squared?'". **Sign in again** (pri), **Not you? Use another email**.
4. **A02 · Link failed**: broken-link icon (rust), "This link didn't work", error banner "It has expired or was already used. Nothing about your account changed." "We'll send a fresh link to asha@example.com." **Send a new link** (pri), **Use a different email**.
5. **A03 · First arrival** (`phone.sp`): a Reel is already playing (orbit diagram). Topic `tag` "Astronomy" and the Reel/Scroll seg (Reel pressed) are visible. A hint card (`role=note`, aria-label "How to move around"): "↑ Swipe up for something new / → Go deeper with the tab on the right / Prefer buttons? The ⋯ menu and the yellow edge tab do the same." **Got it** (`btn.ink.sm`). Title "Why does an orbit keep falling?" The NavBar has Explore active.

**States listed in the notes:** signed out · link requested · link sent · redeeming · expired session · link expired/used · offline (send disabled with banner) · first-arrival hint (shown once, dismissible).

**Required by blueprint §18 (Entry: loading, signed out, expired session, recovery) but NOT drawn:** the **email-entry form itself** (the "Continue with email" target, with its labelled field, validation and the submit/requesting spinner; the notes reference `autocomplete=email` but no field is drawn); the **loading / redeeming** state (app boot, token redemption in progress); the **offline** state (only described: "send disabled with banner"); the **rate-limited resend** state; and the **first-arrival loading** state (no ready Reel yet, starter set empty). The guest/signed-out preview of shared content is drawn on H02, not here.

**Controls → semantics**

| Control | Semantics / contract |
|---|---|
| Continue with email → (undrawn) email form → submit | Auth "request link" (design `auth.request_link{email}`). The blueprint §7 lists no auth routes. The auth provider stays an open decision; the export deliberately avoids committing. |
| I have a sign-in link | Opens the paste/redeem path (`auth.redeem_link{token}`). Native: universal/app link; web: same-tab redemption. |
| Resend the link / Send a new link | Re-issues the link (idempotent per request ID; needs rate-limit copy). |
| Use a different email / Not you? Use another email | Returns to email entry. "Not you?" must also **purge the prior AccountScope** (blueprint §18 client state: on account switch, fence callbacks and purge scoped storage). |
| Sign in again | Re-auth that keeps the held destination (deep link and Scroll anchor). |
| Back (`ibtn`) | Pops to Sign in. |
| Got it | Dismisses the hint once (obs `onboarding.hint_dismissed`); persisted per account and device. |
| First arrival | `POST /v1/experience/open` (create session and return initial offers from a "non-personal starter set"), then `POST /v1/experience/activate` before render. `app.first_open` observation. |

**Data shown:** email address (masked or not; it is shown in full here), the held destination (format tag, duration "6 min", title, anchor label "At 'Why squared?'" = the Scroll section heading of the anchor block), and the topic tag of the first Reel.

**Gestures / motion:** A03 hint teaches **vertical swipe = new subject** and **horizontal (edge tab on the right) = go deeper / continuation**, with button equivalents (the ⋯ menu and the yellow edge tab). Sign-in ground: slow star twinkle.

**Components:** `phone.sp`, `btn.sp`, `btn.ghost`, `btn.pri`, `ibtn`, `banner`, `tag`, held-destination card (cobalt offset shadow, the same "poster card" style as the Scroll hero), hint note card (yellow offset shadow), `seg`, NavBar.

**Conflicts / flags**

- **Held destination card shows the Scroll title before re-auth.** That is acceptable on the user's own device, but the "Not you?" path implies a shared device. **Resolution:** show the destination only from local AccountScope storage of the same account. After "Not you?" the destination is discarded with the scope purge.
- **Duration "6 min" on the Scroll tag** is fine (a content property, not a consumption count).
- The **hint names "the ⋯ menu"**, but no ⋯ menu is drawn on A03 (E01 has one). Make sure the ⋯ menu exists on every encounter.
- **4-tab NavBar** (Explore · Universe · Talk · Keep) vs blueprint §18 "three persistent top-level destinations: Explore, Universe and Conversations", with Saved and account "consistently reachable". The export marks tab labels as an open decision. **Resolution:** the blueprint allows Saved to be reachable without being a tab, so either is compliant. Note that **account/privacy has no visible entry point in the NavBar**. The P01 route of origin must be confirmed (see P01).

---

## E01 · Dimensional TV · Reel

- **Board:** 2174×1480. Five phone frames, with no desktop frame here. Desktop rule: D01 (player + thread rail + optional side panel).
- **Purpose:** the full-bleed Reel encounter, which is the default Explore surface. It shares one action rail with Scroll and has an equal-weight Reel ⇄ Scroll switch. **Swipe up = change subject; swipe left or the right-edge tab = continue the idea** (the arrow points to the destination).

**Frames / states drawn**

1. **Ready · playing** ("Part 1 of a declared series"). Cobalt full-bleed video stage (animated word-graph: "animal", "street", "it", "tired", "because", "cross"). Caption bubble: "'It' looks around the sentence and decides that **animal** matters most." Top-left `tag` "Machine learning"; top-right seg **▶ Reel | ≡ Scroll** (Reel pressed). Right `div.ra` rail with labels under the icons: **Like · Save · Share · Ask**. A yellow right-edge tab reads "PART 2 →" (an `<a>` with aria-label "Continue this idea: Part 2, a worked example"). Bottom-left: `tag.part` "Part 1 of 3", `h2` "Attention, explained with a crowded sentence", a progress bar and `mono` "0:31 / 0:50". NavBar (Explore active).
2. **Paused · transcript** ("Tap pauses; CC opens transcript sheet"). The stage is dimmed with a centre **Play** button. Bottom sheet `div.msheet` with a `div.grab` handle: "TRANSCRIPT" plus controls **Back 10 seconds** (`ibtn`), **Captions on** (`ibtn`, `aria-pressed=true`) and **1×** speed (`btn.sm.ghost`). Time-coded lines (0:18, 0:31 highlighted yellow as the current line, 0:38). **Resume at 0:31** (`btn.ink`). The NavBar is hidden.
3. **Buffering → offline** ("No percentages; position kept"). Dark-cobalt stage, banner "You're offline / This Reel will pick up at 0:31 when you're connected again.", a spinner "Waiting for connection", **Try again** (`btn.sp`) and **Open something you kept** (`btn.ghost` → S01). Title and part tag stay.
4. **Corrected** ("Revised asset; honest note, then plays"). Banner with `tag.cor` "Corrected · 14 Oct": "An earlier version said attention cost grows linearly with length. It grows roughly with the **square** of length. This is the revised Reel." Rail **Like · Saved (pressed, yellow) · Share** (Ask is absent in this frame). Title "Why long prompts cost more", "0:04 / 0:46".
5. **Unavailable** ("Withdrawn asset; no silent substitute"). Light paper frame: `tag` "Machine learning", "This Reel isn't available anymore / It was withdrawn after you saved it. Your other saved encounters are unaffected." **↑ Next subject** (pri) and **Remove from Keep**.

**States in the notes:** playing · paused · buffering · offline · ended → E05/E08 · corrected · unavailable · prefetched-not-visible (emits nothing). Overlays: share H01, ask E04, feedback P03 (long-press / ⋯).

**Required by §18 but NOT drawn:** **loading** (first frame / poster before playback; activation pending); **buffering on its own** (drawn only merged with offline); **ended** (delegated to E05/E08, so acceptable); the **⋯ menu** itself (referenced for "Next subject" and feedback, but no ⋯ button appears on any E01 frame; the feedback menu is drawn on P03); **captions-on playing view** distinct from the transcript sheet; **Unavailable when not saved** (the copy is Keep-specific: "withdrawn after you saved it"); **pending/exhausted navigate outcome** (what swipe-up shows when `navigate` returns pending or exhausted; see E07 and E08).

**Controls → semantics**

| Control | Semantics / blueprint contract |
|---|---|
| Swipe up / ↓ key / "Next subject" | `POST /v1/experience/navigate` (vertical, new subject; design `subject.next`) → ready / pending / exhausted. Then `POST /v1/experience/activate` for the returned offer. |
| Swipe left / → key / yellow edge tab "Part 2 →" | `POST /v1/experience/navigate` (horizontal continuation; design `thread.continue{series}`). The tab label comes from the next declared relationship (`Part N` for a series step, `Related` for a related perspective; see E05). |
| Reel / Scroll seg | Format variant switch (`format.switch`): if the sibling exists → navigate/activate the sibling; if missing → `POST /v1/content-requests` (format variant). See E06. |
| Like / Unlike | `POST /v1/actions` (like/unlike) with state announced ("Like, not liked"). |
| Save / Saved | `POST /v1/actions` (save/unsave) → Keep. |
| Share | Opens H01 share sheet (sheet-open observation only; no share record until `POST /v1/shares`). |
| Ask | Opens E04 composer (→ `POST /v1/content-requests` topic). |
| Tap stage / Play | Pause/resume (client player state; obs `reel.pause`). |
| CC / Captions on | Captions preference (client setting, P01 default) + transcript sheet. |
| Back 10 seconds, 1× | Player seek/speed (client). |
| Resume at 0:31 | Resume playback at the paused playhead. |
| Try again | Retry the media fetch; the position is kept. |
| Open something you kept | → `/saved` (S01). |
| Remove from Keep | `POST /v1/actions` (unsave) on a withdrawn asset. |
| Long-press / ⋯ | P03 feedback menu (Hide/Not interested/Report). |

**Data displayed:** topic tag (topic family name), format availability (seg), caption line, rail state (liked, saved), **series ordinal "Part 1 of 3"** (only for declared series), title, playhead/duration, next-relationship label ("Part 2"), correction tag + date + plain-language correction text, withdrawn state copy.

**Observations:** `reel.visible_interval`, `reel.pause`, `reel.buffer`, `app.visibility` → `POST /v1/observations/batch` (unique media intervals; prefetch emits nothing).

**Gestures / transitions:** vertical swipe (subject) and horizontal swipe (continuation) with an axis lock; tap = pause; the transcript sheet drags down (grab handle). Restore: playhead per exposure; closing a sheet resumes playback; **returning via Back from another screen resumes paused** ("never autoplay with sound after a detour").

**Components:** `phone` (cobalt stage), `seg`, `ra` + `ibtn.sp`, edge tab, `tag.part`, `tag.cor`, `banner`, `msheet` + `grab`, progress bar, NavBar.

**Conflicts / flags**

- **"Part 1 of 3"** is acceptable (a declared series position, §17 "Part labels only for declared sequence positions"). Keep it bound to the series revision. It must not be shown for related items.
- **Corrected banner "once per person"** is consistent with §17 ("honest updated state"). Make sure the correction text is authored content, not model reasoning.
- **Ask missing from the corrected frame's rail**, which contradicts "rail order identical". Treat it as an omission and render all four.
- **No ⋯ menu drawn**, yet it is the accessible equivalent for swipe actions (§18 "keyboard and assistive equivalents for every swipe action"). It must be implemented.
- No consumer exposure of scores or sources: compliant.

---

## E02 · Scroll article

- **Board:** 1752×1480. Four phone frames. Desktop rule: D01 (680px measure, actions in a left rail).
- **Purpose:** the Scroll form of the same explanation ("Attention, slowly" is the Scroll sibling of the Part 1 Reel). Vertical movement reads first. **The end of the article is a boundary, not a launch pad**: momentum settles at the end card, and the next subject needs a fresh act.

**Frames / states drawn**

1. **Opening** ("Poster title, strip, first paragraphs"). Top bar `div.topbar`: **Back to the Reel** (`ibtn`, ‹) on the left and the seg **▶ Reel | ≡ Scroll** (Scroll pressed) on the right. **Poster hero card** (2px ink outline + cobalt offset shadow): `tag` "Machine learning", `h2.disp` "Attention, slowly", standfirst "The same idea as the Reel, with room to try it yourself.", `mono` "A Scroll · 6 min". Under the hero, the floating **action strip** `div.strip` (pill): Like · Save · Share · Ask about this. `h3.h2s` "A sentence is a crowd" and `p.prose` body with an italic quoted sentence. The NavBar is hidden while reading.
2. **Mid-article** ("'Why squared?' with diagram + mini strip"). A thin cobalt **reading line** sits at the top edge (decorative progress). The top bar is unchanged. Heading "Why squared?", prose, then a **static figure block** "EVERY WORD × EVERY WORD": a 6×6 heat-grid (rows/cols the, animal, street, it, was, tired; the "it" row is outlined yellow) with an aria-label and the caption "36 comparisons for six words. The highlighted row is 'it'." A bottom-floating mini strip shows **Saved** (pressed, yellow).
3. **End boundary** ("End mark + end card; momentum settles here, next needs a fresh act"). The last section "What it can't do" is followed by an **end mark** (rule–◆–rule) and an **end card**: `mono` "END OF THIS SCROLL", a yellow block "**Continue this idea**" containing `a.btn` **[Part 2] Attention at work →** (solid, `tag.part`) and `a.btn.ghost` **[Related] A spotlight with a budget →** (dashed outline). Below: **↑ Next subject** (`a.btn`, outlined), the action strip, and the NavBar (it returns at the end).
4. **Fallback · partial** ("Never a blank block"). Section "Scores become weights"; a dashed **block render fallback** box: `mono` "DIAGRAM COULDN'T LOAD · TEXT VERSION", text alternative ("The diagram shows one row of weights for 'it': **animal** gets most of the weight, **tired** some, and **street** very little.") and **Retry diagram**. Then an offline banner "The rest of this Scroll will load when you're online. What's above stays readable." and hatched skeleton lines (the remaining content).

**States in the notes:** loading skeleton · reading · block interacting · end boundary · block render fallback · partial download/offline · corrected (banner under title) · unavailable (E01 pattern).

**Required by §18 but NOT drawn:** **loading skeleton** (initial, before any block); **corrected** Scroll (banner under the title; only described); **unavailable/withdrawn** Scroll (only "E01 pattern"); **restored anchor highlight** ("flashes the paragraph", `content.highlight`; not drawn); **"revision changed → state reset with notice"** for a block; **text selection → share passage** affordance (drawn on H03 instead); the **exhausted end** (no Part 2/Related: see E05/E08); **Part 2 preparing** at the end card (see E05/E07).

**Controls → semantics**

| Control | Semantics / contract |
|---|---|
| Back to the Reel (‹) | One step back through the user's own history (N01 rule). It returns to the Reel **paused** at the same second. On native the back edge does the same. |
| Reel / Scroll seg | Format switch (E06): sibling exists → open the sibling at the matching position; missing → `POST /v1/content-requests` (format variant). |
| Like / Save / Share / Ask strip | `POST /v1/actions` like/save; Share → H01; Ask → E04. |
| Continue this idea: **Part 2 · Attention at work** | `POST /v1/experience/navigate` horizontal, relationship = series step (`thread.continue{series}`). |
| Continue this idea: **Related · A spotlight with a budget** | `POST /v1/experience/navigate` horizontal, relationship = related perspective (`thread.continue{related}`); no part number. |
| ↑ Next subject | `POST /v1/experience/navigate` vertical (`subject.next`); only a **fresh** gesture or this button, never residual momentum. |
| Retry diagram | Re-fetch/re-render that block; the block keeps its ID. |
| Text selection (web) | Allowed. It leads to the snippet composer (H03, `POST /v1/snippets` passage). |

**Data displayed:** topic tag, title, standfirst, format + duration ("A Scroll · 6 min"), section headings (h2/h3), prose, block content, end-card relationships (relationship kind + title per candidate: Part N vs Related), save state.

**Observations:** `scroll.block_coverage`, `scroll.active_dwell`, `scroll.block_interaction{blockId}` → `POST /v1/observations/batch`.

**Restore:** anchor = **article revision + block ID + offset within the block**, plus per-block state. Returning from Share/Ask/a Part restores the exact anchor and flashes the paragraph. A new revision maps the anchor or falls back to the section heading. Route in the notes: `/s/:id#block` (it collides with the share-landing `/s/:token`; see the coverage matrix, where `/scroll/[assetId]` is proposed).

**Gestures:** vertical reading; the axis locks; at the end the boundary state absorbs remaining momentum (§18 gesture arbitration: `ArticleRead → Boundary → SubjectNavigate` only on a fresh deliberate gesture or the Next control). Web: Space/PgDn scroll; boundary keys never trigger the next subject.

**Components:** `topbar`, `seg`, poster hero card, `strip`, `h2s`, `prose`, figure block (heat-grid), end mark, end card ("Continue this idea" with Part/Related buttons), fallback block, `banner`, skeleton lines, NavBar.

**Conflicts / flags**

- The **end card shows Part 2 and Related together**, which keeps the §17 relationships distinct (solid yellow `tag.part` vs dashed "Related"). Compliant. The Part 2 button must never appear unless Part 2 is a declared series step **and** admitted; otherwise show the preparing/request state (E05/E07).
- The **route `/s/:id#block` conflicts** with blueprint `GET /s/:shareToken`. **Resolution:** use `/scroll/[assetId]?rev=&block=` for the reader and keep `/s/[token]` for share landings only.
- Like on Scroll: the brief says "same core actions", so this is fine.
- **"6 min" read time** is a content property, not consumption; acceptable.

---

## E03 · Interactive block gallery

- **Board:** 1752×1480. Four phone frames. Desktop: blocks widen to 880px with the same gestures.
- **Purpose:** the approved interactive block types inside "Attention, slowly". Each block declares **whether it captures gestures**, has a **text alternative**, and **keeps its own state per article revision**. The notes name the versioned types: `diagram.v1, compare.v1, slider.v1, disclosure.v1, code.v1`. "Parameters are bounded; no arbitrary model HTML or JS ever runs."

**Frames / states drawn** (all use the compact reading header `div.mini`: Back to the Reel ‹ + `mono` article title "ATTENTION, SLOWLY"; the seg and strip are hidden mid-read)

1. **Diagram · draggable** ("Component owns the drag"). Lead-in prose "Try it: move 'it' toward a word and watch where its attention goes." Block `div.blk` in the **interacting** state (yellow ring): title "Drag 'it' toward another word", a cobalt canvas with word chips (animal, street, tired, cross) and a draggable yellow "it" node with a grip (••••). Line thickness = attention weight. Buttons **Reset** (`btn.sm`, ↺) and **Describe this diagram** (`btn.sm.ghost`). After-text "Thicker line, more attention."
2. **Comparison + slider** ("Slider owns horizontal drag"). A `compare` block "TWO WAYS TO READ" with two side-by-side cards: "**One word at a time** · Early words fade by the time the end arrives." (fading-dot chain illustration) vs "**All words at once** · Every word can reach every other directly." (all-to-all illustration, yellow fill). A `slider` block (interacting, yellow ring): "Try a longer sentence", `label` "Sentence length", `role=slider` track with endpoints `512 WORDS` and `4,096 WORDS`, and a live result "**~64×** the work of 512 words. Eight times longer, about sixty-four times the work."
3. **Disclosure + code** ("Code scrolls sideways inside the block"). A `disclosure` block with a yellow header button "Why squared?" (`aria-expanded=true`, chevron up) and body text. A `code` block (dark): `mono` "PYTHON · ATTENTION", **Copy** button (→ "Copied"), a `pre` with syntax highlighting and an inner horizontal scrollbar (aria-label "Code example, scrolls horizontally"). After-prose with inline code `q @ k.T`.
4. **Text version** ("Table + stepper, keyboard focus shown"). An article-level `role=switch` toggle "**Text version of diagrams**" (on). A **table alternative** "WHERE 'IT' LOOKS / Attention from 'it' to each word" with Word | Attention rows (animal Most · tired Some · street Little · cross Very little). A **stepper alternative** for the slider: "SENTENCE LENGTH", **− (Shorter)** / `role=status` "**4,096 words** · about 64× the work of 512" / **+ (Longer)** with a visible cobalt focus ring.

**States in the notes:** idle · interacting (yellow ring only; "no ownership wording in the UI") · expanded/collapsed · copied · text version · render fallback (E02-4) · revision changed (state reset with notice).

**Not drawn (but required):** the **revision-changed reset notice**; **idle** (non-interacting) appearances of the diagram/slider (the yellow ring is always on in these frames); **collapsed** disclosure; the **"Copied"** state; the **Describe this diagram** output (presumably it opens the text alternative inline); the **block-snippet share affordance** (drawn on H03).

**Controls → semantics:** all are **client-local block state** persisted by `(articleRevision, blockId)`. Deliberate interactions emit `scroll.block_interaction{blockId, kind}` (summarised; no raw pointer frames) and coverage emits `scroll.block_coverage{blockId}` → `POST /v1/observations/batch`. Sharing a block with its state → H03 (`POST /v1/snippets` kind=block with an allowlisted parameter snapshot). The text-version switch is a reader preference (P01 accessibility could set the default).

**Gestures:** the diagram drag claims the pointer (2D drag; the article must not scroll). The slider claims the **horizontal** axis only after the axis is locked (native gesture handler). The code block has an inner horizontal scroll. Disclosure uses tap. Keyboard: slider arrow ±1 step, Home/End, spoken valuetext; code focusable; tab order follows reading order.

**Components:** `mini` header, `blk` (block frame; `.on`/yellow-ring interacting), word-graph diagram, compare pair cards, slider (track/thumb/endpoints/result), disclosure, code block with Copy, `role=switch` toggle row, data table, stepper (`ibtn` − / status / +).

**Conflicts / flags:** none with product rules. Design note: **"~64×"** is content math, not a consumption number. **Gap:** the blueprint requires "all blocks expose accessibility text and declare whether they capture gestures". The export expresses this in annotations only, so the DSL must carry `capturesGesture` and `altText`/`alternative` per block (see the Scroll block section).

---

## E04 · Topic / content request

- **Board:** 1752×1480. Four phone frames. Desktop: a popover anchored to Ask (D01).
- **Purpose:** an **optional one-shot ask, not a chatbot**. What you ask for now overrides the plan immediately. If nothing fits yet, the feed carries on quietly with a status chip. It is never the home screen and never a chat transcript.

**Frames / states drawn**

1. **Composer** ("Opened from Ask on a Reel"). A `div.msheet[role=dialog][aria-label="Ask for something"]` over the paused Reel: grab handle, `h2` "Ask for something", **Close** (×). `label` "What would you like now?" with a text input (value "Football, right now"). "As a" `role=radiogroup` Format: **Reel / Scroll / Either** (`button.opt[role=radio]`, Either checked). "This is" radiogroup Scope: **About this Reel / Something new** (Something new checked). **Send request** (`btn.pri`, paper-plane icon); helper "We'll find one, or make it for you."
2. **Ready now** ("Existing Reel fits; intent wins at once"). A football Reel (green pitch with player dots) plays immediately. Top-left yellow `tag` "**You asked: football**". Seg and rail as usual; `tag` "Football", title "Why the high press works", "0:03 / 0:55".
3. **Pending** ("Nothing fits yet; feed continues"). The feed continues with an astronomy Reel. Top **request chip** `span.rchip[role=status]`: hatched/animated background, spinner, "**Preparing · Football tactics**" and a **Cancel request** (×) button; sub-text "We'll show it when it's ready. Keep watching meanwhile."
4. **Unavailable** ("Honest reason + nearest options"). Light frame: `tag` "Your request · 'Live scores tonight'", "We can't make that one right now / KnowScroll explains ideas; it doesn't follow live events. Your request has been closed, so nothing is waiting." `mono` "CLOSEST THINGS READY NOW": `a.btn` [Reel] "Why the high press works ›", [Scroll] "Why the Bronze Age collapsed…". **Ask something else** (pri), **Keep watching** (ghost).

**States in the notes:** draft · sending · accepted → ready now · accepted → pending chip (E07 component) · ready later (non-interrupting notice, E06-3) · unavailable (closed, with reason) · cancelled (chip disappears, no toast) · offline (Send disabled with banner).

**Not drawn:** **sending** (button busy state); **offline** composer; **validation** (empty text); the **ready later** notice (drawn on E06/E07); **cancelled** (only described); the **"About this Reel"** scope result (a request scoped to the current explanation, for example a deeper part).

**Controls → semantics**

| Control | Contract |
|---|---|
| Send request | `POST /v1/content-requests` with `{text, format: reel|scroll|either, scope: about_this|new, requestId}` (design `request.topic`). Response: **ready** → `POST /v1/experience/navigate` + `activate` to the matched offer immediately ("intent wins at once"); **pending** → request chip; **unavailable** → closed with reason. Idempotent on `requestId`. |
| Status chip (pending) | `GET /v1/content-requests/:id` polling and/or Socket.IO `scope_changed` for the request. "No new provider attempt" on read. |
| Cancel request (×) | Cancel the content request (design `request.cancel{requestId}`). §7 has no explicit cancel route: **gap**. Propose `POST /v1/content-requests/:id/cancel` (idempotent receipt). |
| Closest things ready now | `POST /v1/experience/navigate` to the named offer (explicit user choice). |
| Ask something else | Reopens the composer. |
| Keep watching | Closes the notice; the feed continues. |
| Close (×) / Esc / back gesture | Dismiss; the Reel stays paused at its second and resumes paused on close; the draft is kept for the session only. |

**Data shown:** the user's request text (echoed in tags), chosen format, scope, matched content (format tag + title), the request's supply state (Preparing), and an honest unavailability reason.

**Observations:** `request.sheet_opened`, `request.sheet_dismissed`.

**Components:** `msheet` + `grab`, text input with label, `opt` radio pills (`role=radio`), `btn.pri`, `rchip` (request chip: hatched shimmer + spinner + label + cancel ×), `tag`, list-link buttons (`a.btn` with a format tag).

**Conflicts / flags**

- "**You asked: football**": acceptable (it echoes the user's own act; it is not provenance or a "why this appeared" panel).
- The **unavailable reason "KnowScroll explains ideas; it doesn't follow live events"** is a policy explanation, fine. It must be a typed reason code mapped to copy, never a model's free-text reasoning.
- "Closest things ready now" includes an unrelated **Bronze Age Scroll**. §18 says "do not silently choose unrelated content". This is explicit and labelled, so it is acceptable. However, the list must come from the composer's ranked offers, not filler. **Resolution:** show only offers the server returned for this request; show none if none.
- The **pending frame drops "Ask" from the rail and hides the seg**, which is inconsistent with the "same rail" rule. Treat it as a drawing omission.
- **Cancel has no blueprint route.** Add one (above).

---

## E05 · Horizontal continuation

- **Board:** 1752×1480. Four phone frames. Desktop: D01 thread rail; ←/→ keys.
- **Purpose:** horizontal moves follow the current idea. A **declared sequel** (solid yellow, "Part N") and a **related angle** (dashed cream, "Related") never look alike. The **thread trail** remembers each step's exact place. It expresses the "horizontal thread" surface of §18 and the series/related relationships of §17.

**Frames / states drawn**

1. **Declared Part 2** ("Series step arrives from the right"). Cobalt Reel (translation diagram "The animal ↔ L'animal", "was too tired ↔ était trop fatigué"). Top-left **trail pill** `button.trail` (aria-label "Thread: Part 2 of 3. Open trail") with three `i.tm` marks (visited white, current yellow, upcoming grey). Left-edge tab "← PART 1" (`a[aria-label="Previous in this thread: Part 1"]`, dark). Right-edge yellow tab "PART 3 →" (`aria-label="Continue: Part 3, Where attention runs out"`). `tag.part` "Part 2 of 3", title "Attention at work: translating one sentence", "0:03 / 0:54". Rail Like/Save/Share/Ask.
2. **Related explanation** ("Another angle — not a sequel"). Black stage (spotlight illustration). Trail pill with a dotted branch mark. `mono` "From Part 2 · Attention at work". `tag` "**Related · another angle**" (outlined, not yellow). Title "A spotlight with a budget", "0:12 / 0:42". Right-edge **dashed cream** tab "RELATED →" (`aria-label="Another related explanation"`).
3. **Thread trail** ("Every step returns to its exact place"). A `msheet` with grab: `mono` "THIS THREAD", `b` "Attention", **Close trail** (×). `a.trow` rows:
   - `tag.part` Part 1 · "Attention, explained with a crowded sentence" · "Finished"
   - (indented) `tag` Scroll · "Attention, slowly" · "At 'Why squared?'"
   - `tag.part` Part 2 · "Attention at work: translating one sentence" · "Paused at 0:03 · you were here" (`aria-current=step`, yellow fill)
   - (indented, dashed) `tag` Related · "A spotlight with a budget" · "Paused at 0:12"
   - `div.trow` (dashed, not a link) `tag.part` Part 3 · "Where attention runs out" · "Not started · ready when you are"
   - Footnote: "Indented rows branch off the series. Part labels appear only for declared parts."
4. **Exhausted · corrected prior** ("Honest end, no auto-advance"). Light frame, trail pill (all three marks), `tag` "Machine learning", `mono` "After Part 3 · Where attention runs out", "**That's the whole thread for now** / There's no Part 4 and nothing more related is ready. You can ask for more, or move somewhere new." Corrected banner: `tag.cor` "Corrected · 14 Oct" "Part 1 was corrected since you watched it." link "**What changed**". **Ask for more on this** (pri → E04), **↑ Next subject**.

**States in the notes:** series step · related step · trail sheet · requested missing part (→ E07) · exhausted · corrected prior. "Never auto-advance at the end of a Reel; the tab just waits."

**Not drawn:** **requested missing part** (delegated to E07 but not drawn as an edge-tab state here; it must show "Part 3 · Preparing", not a ready tab); a **Scroll-format step** in a thread (edge tabs on a Scroll: E02 uses the end card instead); **pending navigate** result; **unavailable step** in the trail (withdrawn Part).

**Controls → semantics**

| Control | Contract |
|---|---|
| Swipe left / → / right-edge tab | `POST /v1/experience/navigate` (horizontal; `thread.continue{relation: series|related, from, to}`), then `activate`. |
| Swipe right / ← / left-edge tab "← Part 1" | `POST /v1/experience/navigate` previous step in this thread (`thread.previous{to}`). This is **not** platform Back. |
| Trail pill | Opens the trail sheet (overlay, no route change; obs `thread.trail_opened`). |
| Trail row | `thread.jump{stepId}` → navigate to that step and restore its anchor (paused). |
| What changed | Opens the corrected Part 1 with its correction banner (E01 corrected). |
| Ask for more on this | E04 composer pre-scoped "About this" → `POST /v1/content-requests` (next part / more). |
| Next subject | `POST /v1/experience/navigate` vertical. |

**Data per trail row:** relationship kind (Part N / Format: Scroll / Related), title, **caller-only** status ("Finished", "At '<section>'", "Paused at 0:03 · you were here", "Paused at 0:12", "Not started · ready when you are"), current step flag, and nesting (branch off the series).

**Restore:** each visited step keeps its own anchor (Reel playhead / Scroll block anchor) and resumes **paused**.

**Gestures:** the horizontal swipe starts **24px in from the edge** on native (the system back edge stays Back). Vertical = subject.

**Components:** `trail` pill with `tm` marks, left/right edge tabs (yellow solid = Part; dashed cream = Related; dark = previous), `tag.part`, `tag` "Related · another angle", `msheet` trail with `trow` (solid / indented / dashed), corrected `banner`.

**Conflicts / flags**

- **"Finished"** in the trail: §17 requires viewed markers to follow "a documented coverage policy … never a learning grade". "Finished" reads like a completion grade. **Resolution:** derive it from the caller's own coverage projection only; when coverage is unknown show nothing; consider a neutral "Watched" or ✓.
- **"Part 2 of 3"** reveals the series length. That is acceptable for a declared series revision, but if Part 3 is not yet admitted the label must not promise it (§17 "preparation is explicitly distinguished from available content").
- The trail is private navigation state. **It must not appear in shared threads** for other people (C04 uses its own navigator).

---

## E06 · Format conversion

- **Board:** 1330×1480. Three phone frames. Desktop: the switch sits in the player header.
- **Purpose:** the same explanation in another representation. **An existing sibling opens at once; a missing one is prepared quietly while the original keeps its place.** Format change is tap-only, never a swipe.

**Frames / states drawn**

1. **Existing sibling opens** ("Reel parked, paused at 0:31"). The Scroll reader with Back (‹) and the seg (Scroll pressed). A dark **return chip** `a.chip`: "⏸ From the Reel at 0:31 · Back to Reel". Tags "Machine learning", "Scroll · 6 min"; poster hero "Attention, slowly / The same idea as the Reel, at reading speed — with a diagram you can push around."; section "A sentence is a crowd" and prose.
2. **Preparing requested variant** ("Original keeps playing"). Cobalt Reel "Why long prompts cost more" 0:18/0:46. Seg: **Reel** (pressed) | **◌ Preparing** (`button.stripe`, striped, announces "Scroll, preparing"). Beneath it a striped chip `div.chip.stripe`: "We'll let you know when the Scroll is ready" + **Cancel** (`btn.sm.ghost`, underlined).
3. **Ready notice** ("Non-interrupting; nothing auto-switches"). The user has moved on to a football Reel. A top toast `div[role=status]` with a teal check: "**Ready:** your Scroll of 'Why long prompts cost more'." **Later** (ghost) / **Open** (pri → E02).

**States in the notes:** sibling exists · preparing (striped segment + quiet chip) · ready toast · cancelled · unavailable ("This one can't be made as a Scroll", Reel unchanged). The toast auto-hides to the request chip and never steals focus.

**Not drawn:** **unavailable** ("This one can't be made as a Scroll"), **cancelled**, the **Scroll → Reel** direction (a Reel being prepared from a Scroll), **sibling loading**.

**Controls → semantics**

| Control | Contract |
|---|---|
| Seg tap (sibling exists) | `POST /v1/experience/navigate` (format variant, same explanation identity; `format.switch{to}`) → `activate` the sibling at the matching anchor. |
| Seg tap (sibling missing) | `POST /v1/content-requests` (format variant; `format.request{explanationId, to}`) → private demand; the seg segment becomes "Preparing". |
| From the Reel at 0:31 · Back to Reel | Back to the parked Reel, **paused** at 0:31 (one history step). |
| Cancel | Cancel the format request (needs a cancel route, see E04). |
| Ready toast Open / Later | Open → navigate/activate the new sibling; Later → the toast collapses into the Keep → Requested chip (E07). |

**Data:** explanation identity, format availability per explanation (`exists | preparing | unavailable`), parked position ("0:31"), request state.

**Restore:** Reel playhead and Scroll anchor are stored separately per explanation; each resumes paused at its own place. "Both formats share one explanation identity, so reading both isn't double-counted": this is a server evidence rule (dedupe per explanation).

**Components:** `seg` with a striped `Preparing` segment, return `chip` (dark pill with pause glyph), striped request chip `chip.stripe`, status toast (teal check, Later/Open), poster hero.

**Conflicts / flags:** none material. Reel and Scroll keep equal status (the seg is the same size on both). The "ready" toast is a non-interrupting status, which is good. Native local notification only if enabled in P01.

---

## E07 · Supply waiting & availability

- **Board:** 1752×1480. Four phone frames. Desktop: the shared request chip component.
- **Purpose:** quiet status attached to what the user asked for. There are five honest states (**requested, preparing, ready, couldn't prepare, cancelled**) plus an honest "that's what's ready for now" exhaustion card. **No percentages, no ETAs.**

**Frames / states drawn**

1. **Requests sheet** ("Keep → Requested, or tap any chip"). A `msheet` over a dimmed screen: `b` "Your requests", **Close** (×). Rows `div.rq` (title + state `chip`):
   - Scroll of "Why long prompts cost more": **✓ Ready · Open** (teal filled)
   - Football: why the high press works, as a Scroll: **◌ Preparing** (striped `chip.stripe`)
   - More on where attention runs out: **🕐 Requested** (outlined)
   - Bronze Age collapse, told through trade routes: **↻ Couldn't prepare · Retry** (rust outline)
   - Orbits as a Reel: **× Cancelled** (dashed)
2. **Ready → opened** ("Opens on demand; nothing interrupted"). The Scroll reader: **Back to requests** (‹), seg (Scroll pressed), teal status chip `role=status` "✓ Ready — the Scroll you asked for", tags "Machine learning" and "Scroll · 5 min", poster hero "Why long prompts cost more", prose.
3. **Couldn't prepare** ("Retry reuses the same request"). A sheet: rust chip "↻ Couldn't prepare", "We couldn't prepare this one / 'Bronze Age collapse, told through trade routes.' Trying again keeps your original request — you won't get two." **↻ Try again** (pri), **Ask differently** (→ E04), **Cancel request**.
4. **Honest exhaustion** ("Nothing more ready on this right now"). `tag` "Football", "You've seen what's ready on this for now / More may come later. Here are a few ways to keep going." **↑ Another subject** (pri), **Something you kept** (→ S01), **Ask for more football** (→ E04). NavBar.

**States in the notes:** requested · preparing · ready · couldn't prepare · cancelled · unavailable ("can't be made") · exhausted. **Offline: chips keep their last known state, marked "may be out of date".**

**Not drawn:** the **offline / stale chip** ("may be out of date"); **unavailable** ("can't be made", drawn on E04 only); the **empty requests sheet**; **loading** the sheet.

**Controls → semantics**

| Control | Contract |
|---|---|
| Ready · Open | Navigate/activate the admitted asset (`request.open`) → `POST /v1/experience/navigate` with an explicit target, then `activate`. |
| Couldn't prepare · Retry / Try again | Retry the **same** request (`request.retry{sameRequestId}`). The blueprint has no retry route: **gap**. Propose `POST /v1/content-requests/:id/retry` (idempotent; never a second demand). |
| Cancel request | `request.cancel` (gap; see E04). |
| Ask differently / Ask for more football | E04 composer (prefilled). |
| Another subject | `POST /v1/experience/navigate` vertical. |
| Something you kept | → `/saved`. |
| Chip states | `GET /v1/content-requests/:id` (read-only poll) + Socket.IO `scope_changed` notifications. |

**Data per request row:** the user-authored request title (or a system-normalised label), the requested format, and the state enum `requested | preparing | ready | failed | cancelled | unavailable`.

**Observations:** `requests.sheet_opened`, `feed.exhausted_shown`.

**Route in the notes:** `/keep?view=requested`. The exhaustion card replaces the next buffer slot in `/explore` (it is the UI of `navigate` → `exhausted`).

**Components:** request sheet (`msheet`, `rq` rows), **state chip** variants (ready teal ✓, preparing striped spinner, requested clock outline, failed rust ↻, cancelled dashed ×), status chip in the reader, exhaustion card.

**Conflicts / flags**

- **Blueprint state names vs design labels:** blueprint "Requested, preparing, ready, unavailable, cancelled". The design adds **"Couldn't prepare"** (a failed state with retry), which §18 allows ("failed/retry/cancel" in the brief). The API enum must distinguish `failed` (retryable) from `unavailable` (closed, cannot be made).
- The Keep → Requested home for requests puts requests in Keep. That is acceptable (it is the user's own private demand), but **Keep must not count requests as saves**.

---

## E08 · Natural thread ending

- **Board:** 1330×1480. Three phone frames. Desktop: the same card, centred.
- **Purpose:** a satisfying stop is a designed state, not an error. Keep a way back, pick something different, or simply be done: "no guilt, no streak". It is shown in place of the next buffer slot when a declared series and its related moves are exhausted, or after an explicit "Done".

**Frames / states drawn**

1. **Thread ends** ("After Part 3 finishes"). Yellow ground; a card with an ink offset shadow: `mono` "ATTENTION · END OF THREAD", `h2` "**A good place to pause**", a part list `div.trl` (`tag.part` Part 1/2/3 + titles), **Keep a way back** (pri, bookmark icon), **↑ Something different**, **Done for now** (ghost). NavBar.
2. **Way back kept** ("Quiet confirmation; nothing to maintain"). Teal check, `h2[role=status]` "We'll bring you back here", "Part 3, end — 'Where attention runs out'." "It's in Keep whenever you want it. Next time you open Explore you'll get something new; this thread waits until you choose it. Nothing expires." **See it in Keep**, **Undo**.
3. **Something different** ("A few fresh subjects, then Ask"). `mono` "PICK A DIRECTION", `h2` "Somewhere new". Three `a.subj` cards, each tinted by its **topic-family hue**: [Football · Reel] "Why the high press works" (coral); [Predictive history · Scroll] "Why the Bronze Age collapsed all at once" (amber); [Astronomy · Reel] "Why does an orbit keep falling?" (paper). **Ask for something**.

**States in the notes:** ending card · way back kept · choose different · **way back failed** (save banner with Retry, card stays). "Titles only — no counts, minutes, 'you learned' or progress meters."

**Not drawn:** **way back failed**; **Done for now** result (a calm Explore with no autoplay).

**Controls → semantics**

| Control | Contract |
|---|---|
| Keep a way back | Save a return path = `POST /v1/actions` (save) with `{threadId, anchor}` (design `keep.return_path`). The §7 actions list Save/Unsave of content. **Gap:** saving a *thread position* (the last step + end anchor) needs either a save target type `thread_return` or a save of the last asset with an anchor. Recommend `POST /v1/actions {kind: save, target: {assetRevisionId, anchor, threadId}}`. |
| Undo | `POST /v1/actions` unsave (same idempotency key family). |
| See it in Keep | → `/saved`. |
| Something different | Shows the "Somewhere new" picker (`subject.next{origin: ending}` → `POST /v1/experience/navigate`). |
| Subject card | `POST /v1/experience/navigate` with the explicit chosen offer, then `activate`. |
| Done for now / Esc | Return to a calm Explore with **no autoplay**. |
| Ask for something | E04. |

**Observations:** `thread.ended`, `ending.shown`.

**Restore:** the return path opens the last step at its end anchor with the trail intact. The ending card is not re-shown unless the thread is reopened. Native back returns to Part 3 paused at its end.

**Components:** ending card (yellow ground, ink offset shadow), `trl` part list, `subj` subject cards with family-hue fills, confirmation card with a teal check.

**Conflicts / flags:** compliant: no counts, no streak, "Nothing expires" (inactivity never destroys). The **subject picker shows three offers**, which is fine. They must be real prepared offers from `navigate`, not hard-coded starters.

---

## E09 · Content range (v2)

- **Board:** 1752×1480. Four phone frames. Desktop: D01 stage; the content keeps its own character.
- **Purpose:** "Same controls, different characters." The rail, the Reel/Scroll switch, the edge tab and the nav never move. **The content inside brings its own palette, imagery, rhythm and motion**: "content character comes from the asset (illustration, palette, caption style, block set), never from a different screen template or chrome."

**Frames drawn**

1. **History Reel** ("Illustrated scene + narration captions"). Ochre illustrated scene (citadel, smoke, ships, sun). `tag` "Predictive history", seg, rail `div.rail > div.ra` Like/Save/Share/Ask. **Narration caption** in italic on a dark plate: "Within about fifty years, palaces from Greece to the Levant fell — and the writing that ran them went quiet." `a.edge` yellow "PART 2 →" (aria "Continue: Part 2, the drought theory"). `tag.part` "Part 1 of 3", title "Why the Bronze Age collapsed all at once", `div.prog > div.bar`, "0:14 / 0:58".
2. **Editorial Scroll** ("Long prose, drop cap, illustrated figure"). Back (‹), seg (Scroll), top reading-progress hairline. `mono` kicker "ESSAY · HISTORY OF THE SEA", `h2` "How Polynesian navigators read the ocean". `p.ed` paragraphs with a **cobalt drop cap "F"**. An illustrated figure (svg, aria-label "Illustration: long ocean swells bending around a small island while a canoe sails past.") with caption "Swells bend around an island. A navigator in the hull could feel the change." The NavBar is hidden while reading. (This frame has no poster hero card, so the editorial template differs from the poster template.)
3. **Football Reel** ("Movement trails + kinetic captions"). Green pitch with player dots and yellow movement arrows. **Kinetic captions**: large display text "The moment the pass **goes back** to the keeper…" with one highlighted chunk (yellow). Rail; `a.edge` **dashed** "RELATED →" (aria "Related: how teams beat the press"). Title "Why the high press works", "0:09 / 0:47".
4. **Comparison Scroll** ("The interactive block is the experience"). Back, `tag` "Astronomy", seg (Scroll). `h2` "How heavy would you be on other worlds?", standfirst "Put in your weight and see what a bathroom scale would read." A block with a cobalt offset shadow: `label` "Your weight on Earth", stepper **− (Less)** / `input` "60 kg" (yellow) / **+ (More)**. 2×2 `div.wcard` result cards (each: world dot + name, `mono` multiplier, `b.disp` value, `div.wbar` proportional bar): Moon 0.17× **10 kg**, Mars 0.38× **23 kg**, Earth 1× **60 kg**, Jupiter 2.53× **152 kg**. Footnote "Jupiter has no ground to stand on; this is at its cloud tops." Then explanatory prose.

**States:** the notes say all of these share the E01/E02 loading, offline, corrected and unavailable states (none are drawn here). Narrated Reels: captions follow narration, italic for voice-over. Kinetic captions: one highlighted chunk at a time.

**Controls → semantics:** identical to E01/E02 (rail → `POST /v1/actions`; edge tab → `navigate` with series vs related; seg → format variant). Comparison block: stepper/input change **client block state** persisted by `(articleRevision, blockId)`; obs `scroll.block_interaction{block: weight-compare}`.

**Observations:** `reel.visible_interval`, `reel.captions_toggled`, `scroll.block_coverage`, `scroll.block_interaction`.

**Accessibility:** captions are real text, not burned in. Football motion has a **reduced-motion still with numbered arrows**. Figures carry alt text. The weight input has a label, a numeric keyboard on native, stepper buttons and announced results.

**Components:** `rail`/`ra`, `edge` (solid Part / dashed Related), `prog`/`bar`, narration caption plate, kinetic caption, editorial kicker + drop-cap paragraph `p.ed`, illustrated figure + caption, number-input stepper, `wcard` + `wbar` result cards.

**Conflicts / flags**

- **Personal data in block state → snippets.** The notes say the entered weight "reappears when you return and **in any shared snippet that includes the configuration**". A body weight is personal data. §17: "no … arbitrary private state enters a card. Another user's draft or hidden block data is not shared by accident." **Resolution:** the block schema must mark parameters as `shareable: false` by default for user-entered personal values (weight). The snippet composer includes only allowlisted, non-personal parameters (or shows the exact value and requires explicit opt-in per H03's "Include my settings" toggle). Never include it by default.
- Reel and Scroll keep equal status. Compliant.
- The content character must come from the asset (theme tokens in the asset/article document), which supports a DSL `theme`/`palette` field.

---

## S01–S02 · Keep library & resume

- **Board:** 1752×1480. Four phone frames (S01 ×3, S02 ×1). Desktop: a two-column grid + detail pane.
- **Purpose:** everything the user kept, with the exact place they left it. Corrected, withdrawn and still-preparing items say so plainly. Opening one **restores the position without pretending the user watched it again**. Keep is also where **requests** and **way-back paths** live.

**Frames / states drawn**

1. **S01 · Library** ("Resume positions on every card"). `h2.disp` "Keep" with an **avatar link "A"** (`aria-label="Account and settings"` → P01; this is the account entry point). A filter `role=group` of `button.fchip[aria-pressed]`: **All · Reels · Scrolls · Requested**. Cards `a.kc` (thumbnail `span.kt`, body `span.kb`, tag, title, `span.r` resume line):
   - [`tag.part` Reel · Part 1] "Attention, explained with a crowded sentence" · "Paused at 0:31"
   - [Scroll · 6 min] "Attention, slowly" · "At 'Why squared?'"
   - [Reel · from Ravi] "What one answer costs to serve" · "Not started"
   - [Way back] "Where attention runs out" · "Part 3, end"
2. **S01 · Empty** ("First visit, nothing kept"). A dashed bookmark tile, "Nothing kept yet / Tap **Save** on any Reel or Scroll and it lands here, with your place kept. Requests you make show up here too." **Go to Explore** (pri).
3. **S01 · Changed items** ("Corrected · withdrawn · preparing"):
   - Corrected card (rust outline) [`tag.cor` Corrected · 14 Oct] "Why long prompts cost more" · "Revised since you kept it · What changed"
   - Withdrawn card (dashed, greyed `div.kc`, not a link) [No longer available] "How chatbots remember you" · "Withdrawn after you kept it" · **Remove** (`btn.sm`)
   - Preparing card (`a.kc.stripe`, striped, spinner thumb) [Requested · Scroll] "Football: why the high press works" · "Preparing"
   - Normal card [Scroll · 6 min] "Attention, slowly" · "At 'Why squared?'"
4. **S02 · Detail & resume** ("Exact anchor, no fake encounter"). **Back to Keep** (‹), **Share** (`ibtn`). Poster card: tags "Machine learning", "Scroll · 6 min", `h2` "Attention, slowly", "Kept on 12 Oct. Same explanation as the Reel 'Attention, explained with a crowded sentence'." A yellow inset "WHERE YOU LEFT OFF / **Why squared?** / Third of four sections · diagram left where you set it". **Resume at 'Why squared?'** (pri), **Start from the top**, **See it in your universe** (→ U04), **Remove from Keep** (rust text button).

**States in the notes:** loading (card skeletons) · library · empty · corrected item · withdrawn item · requested/preparing item · offline (cached list, "may be out of date") · remove failed (card returns + Retry banner).

**Not drawn:** **loading skeletons**, **offline / may-be-out-of-date**, **remove failed + Retry**, **filter-empty** (for example "No Scrolls kept"), **S02 for a Reel** (playhead resume), the **S02 corrected detail** with the anchor mapping or fallback, and the **undo toast** after remove.

**Controls → semantics**

| Control | Contract |
|---|---|
| Card tap / Resume at "…" | Open the exact revision at the saved anchor (`keep.open{itemId, anchor}`) → `POST /v1/experience/navigate` (explicit target + anchor) → `activate`. **Restoration is session state only**; a new encounter begins only when content is visible. |
| Start from the top | Same, with anchor = start. |
| Filters All/Reels/Scrolls/Requested | Client filter over the saved list (server list endpoint; see the gap note). `Requested` = the user's content requests (E07). |
| Remove / Remove from Keep / swipe-to-remove / long-press | `POST /v1/actions` (unsave; design `keep.remove{itemId}`), with an undo toast. |
| What changed | Opens the corrected revision with its banner. |
| Share | H01 share sheet. |
| See it in your universe | → `/planet/[id]?region=` (U04), using the item's place in the personal geography (only if a region exists). |
| Avatar "A" | → `/account` (P01). |

**Data per card:** format + part tag (or "Way back", "Requested · Scroll", "from Ravi" = share origin), title, thumbnail (topic-family colour or poster), caller-only resume line (Paused at m:ss / At "<section>" / Not started / Part 3, end / Preparing / Revised since you kept it / Withdrawn after you kept it), saved date ("Kept on 12 Oct"), and format sibling relation ("Same explanation as the Reel …").

**Observations:** `keep.restored` (session-only), then normal reel/scroll observations once content is visible. The detail page records nothing.

**Components:** `fchip` filter chips, `kc` keep card (`kt` thumb, `kb` body, `r` resume line; variants: normal, corrected rust, withdrawn dashed/disabled, preparing striped), empty state (dashed icon tile), detail poster card with "Where you left off" inset, avatar button.

**Conflicts / flags**

- **"Third of four sections"** is a position, not a consumption count. Acceptable, but keep it out of any aggregate ("you've read 75%").
- **"Reel · from Ravi"** shows share origin on the user's own item. That is acceptable (a real share), but only if the share was actually received in a conversation the user is in.
- **Blueprint §7 has no "list saved items" GET route** (it has `POST /v1/actions` only). **Gap:** add `GET /v1/saved?filter=&cursor=` (and `GET /v1/content-requests?status=` for the Requested filter).
- The S01/S02 frames carry a **Keep tab**, while the blueprint recommends three tabs (Saved reachable). Keep as a fourth tab is allowed (see the open decision).

---

## U01 · Universe overview

- **Board:** 1752×1480. Four `phone.sp` frames (dark spatial register). Desktop: D02 (map + side list).
- **Purpose:** "A calm, spacious map of what you have actually explored. Systems are broad topics, stars organise them; **nothing is counted, scored or lost after time away**." It is the Universe tab root.

**Frames / states drawn**

1. **Empty · first visit** ("Background only; no promises"). `div.utitle` "Your universe", a large soft radial glow, `h2` "Your universe starts quiet. / It takes shape from what you watch and read." `a.pillsp` (cream pill) **Go to Explore**.
2. **Emerging** ("Dust + protostar; tapped"). A dotted-ring dust cloud with a protostar dot (`button.hit` aria "A gathering of recent explorations", `aria-expanded=true`). A small cream popover: "Recent explorations are gathering here." + **Close note** (×). It is unlabelled on the map.
3. **Established** ("Two systems, dust, a room station"). The **Lately** toggle (`button.pillsp[aria-pressed=true]`, green dot) is top-right. The **Machine learning** system (organising star + hairline orbit + planets "Attention", "Inference & serving"; label "Machine learning / A SYSTEM"), a **room station** glyph "Model serving room" linked by a dotted route, the **Backend systems** system (planet "Queues"), and a faint dust cloud. `button.hit` per body (aria "Machine learning, a system", "Backend systems, a system", "Model serving room, a room station"). `a.pillgh` (ghost pill) **List view**.
4. **Returning after absence** ("Calm, intact, ship at last place"). Sub-title "Everything is where you left it." Lately is off. The **ship** marker (white arrow with a dashed trail) sits at the Attention planet, which has a yellow ring. **↗ Return to Attention** (`pillsp`).

**States in the notes:** empty · emerging (dust/protostar, unlabelled) · established · returning (calm, intact) · **stale scene refresh** (the old scene stays and quietly redraws) · **low-detail fallback** (U03-3). The dust note is a small cream popover, never a dialog.

**Required by §18 but NOT drawn here:** **loading** (first scene fetch); **stale scene refresh** (described only; U02 draws "Drawing…"); **offline** (cached scene); **error/retry** scene fetch; **reduced-motion/low-detail** (drawn on U03 only); **paused-recording** universe (J4 storyboard covers the copy). The U01 **List view** is drawn only for a system (U02-4), not for the whole universe (U08 has search/list).

**Controls → semantics**

| Control | Contract |
|---|---|
| Tap a system (`hit`) | Camera fly-in → `/universe/system/[id]` (U02); obs `universe.select{system}`. |
| Tap the room station | → R01 room preview. |
| Lately (toggle) | Client lens: a recent-activity glow from the user's own recent exploration (obs `universe.lens{lately}`); it persists per device. |
| List view | Accessible outline sheet (U02-4 / U08). |
| Return to Attention | Camera → last region (ship); `?focus=last`; obs `universe.return`. |
| Go to Explore | → `/explore`. |
| Dust popover × | Dismiss note. |
| Pinch/scroll zoom, drag pan, arrow keys / +/− (web) | Camera (client). |

**Backend:** `GET /v1/universe` (revision-aware scene snapshot/deltas). **No commands**: "Map visits are never content evidence and never grow a world." Formation transitions not yet seen play once (U05).

**Data:** systems (id, name, kind label "A system", family hue, star), planets (name, position), room stations (name, link), dust (unlabelled), ship/last place, lens state. **No counts, no scores.**

**Components:** `phone.sp`, `utitle`, `pillsp` (cream pill), `pillgh` (ghost pill), `hit` (48px invisible hit button over each body), dust popover, the ship marker, the station glyph, orbits, star glow.

**Conflicts / flags**

- **"Lately" lens** (a recent-activity glow) is acceptable (own data, no numbers). Whether it is on by default after absence is an **open design decision** in the export. The brief's "no missed-reward pressure" suggests it should be **off after absence** (as drawn in frame 4).
- The **emerging popover copy "Recent explorations are gathering here"** is fine (no evidence claim).
- **No consumer copy reveals thresholds.** Compliant.

---

## U02 · Topic system

- **Board:** 1752×1480. Four `phone.sp` frames. Desktop: D02.
- **Purpose:** one topic system (Machine learning) organised by its star. **Planets are subtopics**, a **dashed route** leads to a neighbouring system, and the **station is a shared room**. The **List view replaces the rejected grey Worlds dialog.**

**Frames / states drawn**

1. **Established** ("Star, planets, dust, route, station"). **‹ Universe** back pill (`a.pillsp`), Lately (`pillgh`). `div.sysh`: `h2` "Machine learning", `mono` "A SYSTEM". The star with an orbit ellipse; planets **Attention** and **Inference & serving** (angular teal/green continents) as `a.hit` (aria "Attention, a planet" → U03); a dust cloud (not tappable); the **Model serving room** station (`a.hit` → R01) with a dotted route continuing off-screen; a **Backend systems ›** pill (neighbouring system route); **List view** pill.
2. **Forming · scene pending** ("Old scene stays; one slot draws"). The same scene with a **dashed empty circle slot** and a `role=status` chip "◌ Drawing…". Copy: "Part of this system is still being drawn. Everything else works as usual."
3. **Calm · dormant** ("Desaturated, no glow, nothing removed"). Desaturated planets and star with no glow. "Quiet for a while. Pick up anywhere." **Open Attention** (`pillsp`).
4. **List view** ("Accessible outline; replaces grey dialog"). A cream `msheet[role=dialog][aria-label="Machine learning, list view"]`: `mono` "A SYSTEM · LIST VIEW", `h2` "Machine learning", **Close list view** (×). `h3` link **Attention** · "a planet" with region rows `a.lrow` **Mechanism › · Example › · Limits ›**; `h3` **Inference & serving** · "a planet" with **Batching › · Deployment › · Latency › · Cost ›**; `h3.mono` "ROOMS" with **Model serving room ›**.

**States in the notes:** established · forming (dashed slot + "Drawing…", no percentage) · calm (−35% saturation, no glow, orbit 10%) · hidden/private boundary (fog, see U06) · list view sheet. Stale scene: keep the old one and swap when the new revision lands.

**Not drawn:** **loading** (initial scene); **hidden/private boundary** (U06); **error** (scene chunk failed); **empty system** (a system with a star but no planets yet).

**Controls → semantics**

| Control | Contract |
|---|---|
| ‹ Universe | Back to U01 at the exact framing. |
| Planet `hit` / list `h3` link | → `/planet/[id]` (U03), camera dolly; obs `universe.select{planet}`. |
| Region row (`lrow`) | → `/planet/[id]?region=[regionId]` (U04). |
| Station / Rooms row | → `/rooms/[id]` preview (R01). |
| Backend systems › (dashed route) | → neighbouring `/universe/system/[id]`; obs `universe.route{to}`. |
| List view | Opens the outline sheet (`?view=list` deep link); obs `universe.list_open`. |
| Open Attention (calm) | → U03. |

**Backend:** `GET /v1/universe` (scene revision by id). "Client never computes eligibility or forms planets itself" (§18 client state).

**Data:** system name/kind, planets (name, kind, family hue, terrain), regions per planet (names only), room stations (names), neighbour routes, pending slots, dormant/calm flag (a presentation state, not deletion).

**Components:** back pill, `sysh` header, star/orbit/planet bodies with `hit` overlays, dashed pending slot + "Drawing…" status chip, station glyph, route pill, list-view sheet (`lrow` region rows in a 2-column grid, h3 planet links, Rooms section).

**Conflicts / flags:** none. Calm/dormant explicitly "nothing removed", which satisfies "inactivity never destroys the universe".

---

## U03 · Planet close-up

- **Board:** 1330×1480. Three `phone.sp` frames. Desktop: D02 (the planet fills the left 2/3).
- **Purpose:** Asha's "Inference & serving" planet drawn **as a place**: fjord coastline, terraced plateaus, daylight terminator, a coastal route and two landmarks (lighthouse, gate). **Regions are pins on its land, not rows in a sheet.**

**Frames / states drawn**

1. **Arrival** ("Ship approaches; regions on the land"). Back pill **‹ Machine learning**. A globe with angular teal/green land; **region pins** (octagon pins + dark label pills `span.plab`): **Batching, Deployment, Latency, Cost** (`a.hit` aria "Batching, a region"…), linked by a dashed white route; lighthouse landmark; the ship arriving on a dashed yellow trail. Caption block: `mono` "A PLANET IN MACHINE LEARNING", `h2` "Inference & serving", "Where a trained model meets real requests.", "Tap a region to land."
2. **Region focus** ("Camera low over the terraces; Deployment selected"). Back pill **‹ Inference & serving**. A close camera over the terraces; the **Deployment** pin is selected (yellow pin + yellow label, `aria-current=true`); the other pins are dark.
3. **Low detail · reduced motion** ("Flat silhouette + plain list, same layout"). `tag.sp` "LOW DETAIL", `h2` "Inference & serving", `mono` "A PLANET IN MACHINE LEARNING", a flat land silhouette with pins, and a `ul[aria-label=Regions]` list of `a.lrow` cards with one-line descriptions: **Batching** "Serving many requests in one pass" · **Deployment** "Where the model runs" (yellow, `aria-current`) · **Latency** "How long an answer takes" · **Cost** "What each answer costs to serve".

**States in the notes:** arrival · region focus · low detail (also the automatic renderer fallback; it keeps the same silhouette) · pending scene chunk (dashed pin, "Drawing…") · offline (last scene cached).

**Not drawn:** **pending scene chunk** (dashed pin), **offline cached**, **loading**, **a planet with a single region**.

**Controls → semantics**

| Control | Contract |
|---|---|
| Region pin (first tap) | Focus/select the region (camera); obs `universe.select{region}`. |
| Pin second tap / list row | → U04 region card (`/planet/[id]?region=`). |
| ‹ Machine learning / ‹ Inference & serving | Back one camera level (a history entry). |
| Pinch / drag | Rotate/zoom (client camera). |
| Low-detail | P01 Accessibility toggle; also the automatic fallback (obs `universe.render_fallback{reason}`). |

**Backend:** `GET /v1/universe` (planet descriptor: terrain seed, regions, landmarks). "Terraces, clouds and landmarks come from a stable seed; they never imply more evidence. Pins map 1:1 to supported regions."

**Data:** planet name, parent system, one-line planet description, regions (name, one-line description, position on terrain), landmarks (decorative), selected region, ship position.

**Components:** back pill, globe/terrain renderer, region pin (octagon; default dark, selected yellow, "you were here" ring), `plab` label pill, `tag.sp` Low detail, `lrow` list cards with descriptions.

**Conflicts / flags:** none. The per-planet descriptions ("Where a trained model meets real requests") are topic copy, not personal interpretation. Fine.

---

## U04 · Regions & topic card

- **Board:** 1330×1480. Three frames (two `phone.sp`, one paper/cobalt encounter). Desktop: the card docks right.
- **Purpose:** a region opens a **compact card with one encounter**. Open goes straight in; returning lands on the exact same spot with the ship parked.

**Frames / states drawn**

1. **Region card** ("Deployment selected; one encounter"). Region close-up (polygonal land cells), Deployment selected. A cream card `div[role=dialog][aria-label="Deployment region"]`: `mono` "A REEL · IN DEPLOYMENT", **Close card** (×), `h2` "Where should the model run?", "On the phone, on a server, or both — and what each choice gives up." **Open** (`btn.ink`), **Close** (ghost), link **More in Deployment**.
2. **Encounter entry** ("Paper register, breadcrumb back"). A cobalt Reel: **Back to Deployment** (‹ `ibtn`) + breadcrumb chip `tag` "⊙ FROM DEPLOYMENT · INFERENCE & SERVING", seg Reel/Scroll (drawn centred), phone ↔ servers diagram, rail **Like · Save · Share** (no Ask), title, "0:03 / 0:52". No NavBar.
3. **Exact return** ("Same camera; ship parked; card closed"). The same region close-up, the Deployment pin with a **concentric ring**, the ship parked, label "**Deployment · you were here**" (`a.hit` aria "Deployment, a region, you were here"). Dark status toast `role=status` "✓ Back where you were. 'Where should the model run?' is paused at 0:03."

**States in the notes:** card open · encounter entry (paper register, breadcrumb chip) · exact return (ring + status line) · **encounter unavailable** (the card says so; the region stays) · **offline** (the card shows "Opens when you're back online").

**Not drawn:** **encounter unavailable**, **offline card**, **a region with a Scroll** encounter (the card kicker would read "A Scroll · in …"), and **More in Deployment** results.

**Controls → semantics**

| Control | Contract |
|---|---|
| Open | Encounter from the map: `POST /v1/experience/navigate` with explicit target (origin = region) → `activate` → `/reel/[assetId]?from=region` (obs `universe.open_encounter`). |
| More in Deployment | `POST /v1/experience/navigate` with a **region-scoped intent** (more encounters from this region in Explore). This implies the navigate intent schema supports `{scope: region, regionId}`. |
| Close / × / Esc | Close the card; focus returns to the pin. |
| Breadcrumb chip / ‹ | Behaves exactly like Back → the region with the stored camera (J3 step 5). |
| Exact return | Camera `{system, planet, region, zoom, rotation}` restored; the encounter playhead is stored separately (paused at 0:03); obs `universe.return`. |

**Data:** the region's single encounter (format kicker, title, one-line description), breadcrumb (region · planet), "you were here" marker. "**The card never lists sources, badges or counts.**"

**Components:** region card (labelled dialog), breadcrumb chip, "you were here" ring pin + label, status toast (dark, check glyph).

**Conflicts / flags**

- The **encounter-entry Reel omits Ask** and centres the seg. The E09 rule says the seg is fixed top-right and the rail is Like · Save · Share · Ask everywhere. Treat this as a drawing inconsistency and use the standard Reel chrome plus the breadcrumb chip.
- **One encounter per region card**: the server must pick it (a Composer offer for the region), not the client.

---

## U05 · Formation transition storyboard

- **Board:** 2174×1480. Five `phone.sp` frames (a timed sequence). Desktop: n/a (the same animation plays in the map view).
- **Purpose:** a **2.4-second sequence that plays once, only after a geography change has actually been applied**. It shows a new place and never says what the user learned. **Skip** is always available; reduced motion shows the last frame.

**Frames (timeline beats)**

1. **Dust drifts** (0.0–0.5s, scattered, slow): a faint radial disc with drifting dust streaks. **Skip** (`button.skip`, cream pill, top-right).
2. **Gathering** (0.5–1.1s, spiral inward): dust condenses into a dotted spiral ring. Skip.
3. **Protostar** (1.1–1.6s, the core lights and the disc flattens): an elliptical disc with a bright core. Skip.
4. **Star & first orbit** (1.6–2.0s, the system is named): star + orbit ellipse; label "Machine learning / A SYSTEM". Skip.
5. **Planet settles** (2.0–2.4s, then interactive): the "Attention" planet on the orbit; a cream status pill `role=status` "**A new place: Attention**"; the button changes to **Done** (ghost). A dashed note: "REDUCED MOTION · Frames 1–4 are skipped: this final still and caption appear with a 200ms fade."

**States in the notes:** dust · gathering · protostar · star & orbit (new system only) · planet settles. **A planet in an existing system skips beats 3–4.** Reconnect / late open / already seen → final state directly.

**Not drawn:** the **existing-system variant** (beats 1, 2, 5 only); **region formation** (does a new region animate?); **multiple simultaneous deltas** (queueing order).

**Controls → semantics:** Skip → final state immediately (obs `formation.skipped{transitionId}`); Done / tap the planet → U03; completion obs `formation.shown{transitionId}`. **Driven by a server delta id** (`GET /v1/universe` deltas carrying `transitionId`); "the client never decides that something formed. A stale delta after a reset is never replayed" (it is fenced by `privacyEpoch`). Played transition IDs are stored **per account** so the sequence shows once across devices. **Gap:** this needs a server-side "seen transitions" record (an action or observation acknowledged by the server); §7 does not list one. Propose posting `formation.shown/skipped` via `POST /v1/observations/batch` and projecting `seenTransitionIds` into the universe read model.

**Timing tokens:** total 2.4s; beats 0.5 / 0.6 / 0.5 / 0.4 / 0.4s; reduced motion = 200ms fade; "glow changes stay under 3 per second".

**Components:** `phone.sp`, `skip` pill, particle/dust field, protostar disc, star + orbit, planet body, status pill.

**Conflicts / flags:** compliant ("No share prompt, no celebration, no 'you learned'"). It plays on `/universe` or `/universe/:system` the next time the map opens and **never interrupts a Reel or Scroll**.

---

## U06 · Friend universe visit

- **Board:** 1752×1480. Four `phone.sp` frames. Desktop: D02 pattern.
- **Purpose:** visiting Ravi's universe. His ML is recognisably ML but unmistakably his (crystal archipelago, glacial light, aurora, a debris ring around "Hardware"). **Private parts are never drawn**: one generic haze, identical for every visit, and a plain banner.

**Frames / states drawn**

1. **Visiting Ravi** ("Shared systems; generic visitor haze"). Visitor bar `div.vbar`: avatar `span.av` "R", "**Visiting Ravi** / Only what he shares", **Leave** (`btn.ink.sm`). Privacy banner button `button.priv` "🔒 Some of Ravi's universe is private". Scene: the Model serving room station, the **Machine learning** system (planets "Inference & serving", "Hardware" with a debris ring), and the **Football** system (planet "Tactics"). `a.hit` aria "Ravi's Machine learning, a system", "Ravi's Football, a system". A soft edge haze.
2. **Ravi's ML system** ("Same room, different place"). The visitor bar sub-title becomes "Machine learning". A station popover `div.popc[role=dialog][aria-label="Model serving room"]`: `mono` "A ROOM STATION", **Model serving room**, "Same room as on your map — it just sits in a different place in Ravi's universe." **Enter room** (`btn.pri.sm` → R02).
3. **Private parts explained** ("Banner tapped; nothing located or sized"). A popover `div.popc[aria-label="About private parts"]`: "Some of Ravi's universe is private" + Close; "You see only the systems he chose to share. The map doesn't show where the rest are, how large they are, or whether there are any. / The soft haze at the edges looks the same on every visit, for everyone."
4. **Revoked / expired** ("Access ends; nothing cached"). Avatar "R", `h2` "Ravi stopped sharing his universe", "Nothing from it is kept on your side. Your conversations with Ravi are unaffected." **Back to your universe** (`pillsp`), link **Open conversation with Ravi** (→ C02).

**Notes:** route `/visit/ravi.m` from a friend row (F01), a share card or a room member; it requires Ravi's visibility setting (F02) to include Asha, otherwise the **denied** state shows directly. "Visitors never see Ravi's encounters or history." "The visitor scene is server-filtered; private bodies never reach the client. Visiting creates no evidence for either person."

**Not drawn:** the **denied** state (never shared with you, distinct from revoked); **loading** the visitor scene; **offline**; the **list view of shared systems**; **planet close-up while visiting** (is U03 reachable on a visit? The notes say "open a shared system", but nothing below system level is drawn).

**Controls → semantics**

| Control | Contract |
|---|---|
| Open visit | Design `visit.open{handle}`. **§7 has no visit route: gap.** Propose `GET /v1/visits/:handle/universe` (server-filtered, permission-checked scene; revocation re-checked per request; Socket.IO `scope_changed` on revoke). |
| System `hit` | Camera into a shared system (obs `visit.select{system}`). |
| Privacy banner | Opens the generic explanation popover (static copy). |
| Station → Enter room | `/rooms/[id]` (R02 if a member; otherwise the R01 preview/join); design `room.join{roomId}` → room commands (§7 "`GET /v1/rooms/:id` and room commands"). |
| Leave / Back | Return to the user's own universe at the exact camera; Ravi's camera is not stored. |
| Open conversation with Ravi | → `/conversations/[id]`. |

**Components:** visitor bar (`vbar`, `av` avatar, Leave), privacy banner button (`priv`), popover card (`popc`), edge haze decoration, revoked state card.

**Conflicts / flags**

- **Compliant with the privacy rule:** "No fog shape, size or position can hint at hidden systems"; the haze is identical for everyone; the banner shows whenever any limit applies.
- The visitor sees **topic names of shared systems** (Football → Tactics). This is acceptable because it is deliberately shared. F01's visibility control must make it clear that sharing a system reveals its planet names.
- **"Nothing from it is kept on your side"**: the client must actually purge cached visit scenes on revoke (query-cache eviction keyed by the visit scope).

---

## U07 · Same ML, three people (v2)

- **Board:** 2596×1480. Six `phone.sp` frames: system and planet for Asha, Ravi and Meera.
- **Purpose:** a **design-specification board, not a product screen**. It shows how one topic (Machine learning) renders for three people: "All three read as ML … but coastline, material, light, landmarks, region layout and neighbours are personal. Cover the name: can you still tell them apart?"

**Frames:** each frame carries an owner chip `span.own` (`span.av` initial + name), which is design annotation only.

1. **A · system**: daylight, terraces. Planets Attention and Inference & serving, the Model serving room station, Backend systems nearby.
2. **R · system**: glacial, a debris ring on Hardware, the Football system close, the room station top-left.
3. **M · system**: dusk haze. Planets Language models, Inference & serving, Ethics & policy, the room station, a Linguistics neighbour.
4. **A · planet**: fjords, terraces, coastal route, harbour + lighthouse. Pins Batching/Deployment/Latency/Cost. Caption `div.pcap`: "A PLANET IN MACHINE LEARNING / Inference & serving / Where a trained model meets real requests."
5. **R · planet**: crystal archipelago (faceted hex islands), sea routes, aurora band.
6. **M · planet**: canyons, dunes, basin paths, observatory + bridge.

**Rules in the notes (renderer contract):**

- **Shared family cues (never vary):** teal ocean hue family · angular outlined land · one organising star with the same core and glow · **octagon region pins with the same two states** · label pills on fixed baselines · route language (**dashed = sea/coastal, thin solid = overland**).
- **Personal variation (seeded per person):** coastline/land structure (continent / archipelago / basin) · material (terraced grass / faceted crystal / sage with dunes and canyons) · light (daylight terminator / glacial with aurora / dusk haze with rim light) · landmark glyphs · region arrangement and routes · orbit tilt and order · neighbouring topics.
- **Landmarks** are decoration from a stable personal seed placed beside an actual region; they **never encode amount watched, recency or any score**; pins map 1:1 to supported regions; terrain size never implies more evidence.
- "The seed and materials are part of the scene descriptor, so the same person sees the same world on every device." Grayscale test: identity is carried by shape, texture and light, not hue alone. "2D layered SVG/Skia-feasible; no 3D required."

**Backend:** the `GET /v1/universe` scene descriptor must include `{familyId, seed, material, light, landmarkGlyphs[], regionLayout, orbitTilt/order}`. Visits use the same descriptor from the friend's scene (server-filtered).

**Conflicts / flags:** the three-people comparison is **not a consumer surface**. The product never shows people's worlds side by side (that would invite comparison). Implement the rules, not a comparison screen.

---

## U08 · Mature universe (v2)

- **Board:** 1752×1480. Four `phone.sp` frames.
- **Purpose:** "A year in: a dozen systems across several families. **Labels follow zoom levels**, quiet areas **merge into named sky regions**, and **search** or the **outline** jump straight to any place. Nothing is counted."

**Frames / states drawn**

1. **Far zoom** ("System names only; quiet areas merge"). `div.top`: `h2` "Your universe", **Search your universe** (`ibtn.sp`, magnifier), **Lately** (`pillsp`). Star dots with system labels: Astronomy, Predictive history, **Machine learning** (larger, ship nearby), Backend systems, Football, Climate, Economics. Two **merged sky regions** with soft glows: "**Arts & ideas**" (`button.hit` aria "Arts and ideas: Music theory, Philosophy of mind, Languages") and "**Everyday systems**" (aria "…: Urban design, Cooking chemistry").
2. **Mid zoom · selected** ("Planets appear; low priority fades to dots"). Back pill **‹ Whole universe**. ML with its planets and the room station; **Backend systems** selected (yellow ring; planets Caching, Queues). A compact card: `mono` "A SYSTEM · SYSTEMS FAMILY", **Backend systems**, "Queues, caching and how services keep up.", **Open system** (`btn.ink`), **Close** (ghost).
3. **Find** ("Search systems, planets, regions, rooms"). `label` "Search your universe", `input[type=search]` "cost" (yellow focus ring), **Cancel** (`pillgh`). Results `role=listbox` with `a.res[role=option]` rows: an icon (octagon = region, dot = planet in its family hue, station glyph = room) + name + `span.kind` breadcrumb:
   - **Cost**: "REGION · INFERENCE & SERVING · MACHINE LEARNING"
   - **Cost of living**: "PLANET · ECONOMICS"
   - **Carbon cost**: "REGION · ENERGY · CLIMATE"
   - **Model serving room**: "ROOM · TALKS ABOUT SERVING COST"
   - Footer: "Choosing a result flies you there. Back returns to where you were looking."
4. **List view** ("Outline by family; Lately lens"). Back pill **‹ Map**. A cream `msheet`: `h2` "Your universe", `label` "Lately" + `role=switch` (on); "Lately on: places you visited recently come first in each group." `nav.grp[aria-label="Universe outline"]` grouped by **family headings** `h3`: LEARNING MACHINES (Machine learning: "Attention, Inference & serving"), SYSTEMS (Backend systems, Economics, Urban design), WORLDS (Astronomy, Climate), PAST (Predictive history), PLAY (Football), ARTS & IDEAS (Music theory). `a.orow` rows with family-hue `i.dot`.

**LOD rules (notes):** **Far:** system names only; quiet close systems merge into a named sky region. **Mid:** planets and rooms of systems in view; lower-priority labels fade to dots. **Near:** regions. Priority = how recently *you* visited, then size on screen. Labels never overlap; crowded labels get leader lines. There is a label budget per viewport.

**States in the notes:** far · mid · near · selected · search (typing, results, **no match: "Nothing here called that yet"**) · list view · low detail (list + flat tiles) · stale scene refreshing quietly.

**Not drawn:** **near zoom**, **no-match search**, **low-detail list + flat tiles**, **merged-region tap** (zoom until separated).

**Controls → semantics**

| Control | Contract |
|---|---|
| Tap system/cluster | Select (yellow ring + compact card); second tap / Open system → U02. |
| Tap merged region | Zoom in until its systems separate. |
| Search | Client-side search over the user's own scene/map index ("Search runs on your own map index only; queries are not logged with their text"). Obs `universe.search{resultKind}` (kind only). Result → camera fly-to (a history entry). |
| Lately switch | Reorders the outline groups by own recency (client lens). |
| Whole universe / Map back pills | Camera history pop. |

**Backend:** `GET /v1/universe` must expose families (id, name, hue), systems, planets, regions and rooms with names and one-line descriptions, enough for the client index. No server search route is needed if the client indexes the permitted snapshot.

**Components:** `top` header with search `ibtn.sp`, merged sky-region glow + `hit`, selection ring + compact system card, search field + listbox `res` rows with `kind` breadcrumbs, outline sheet (`grp` nav, `h3` family headings, `orow` rows with `dot`), `role=switch` Lately toggle.

**Conflicts / flags**

- **The LOD priority uses "how recently you visited"**, which is own data. Acceptable, but it must not be presented as a measure (no "most visited" labels).
- In frame 4 the **list content runs under the NavBar**. Add bottom inset padding (implementation note).
- **Search result kind "Room · talks about serving cost"**: the room description must come from the room's own public description, not from conversation content.

---

## H01 · Share sheet & friend picker

- **Board:** 2174×1480. Five phone frames. Desktop: a popover (D01) / inline in D03.
- **Purpose:** "Here's something interesting. Come explore it with me." The same sheet appears on Reels and Scrolls. It can **send to a chat**, **start a content thread with friends**, **share an exact moment**, or **take a link elsewhere**. A thread can start from a single Reel or Scroll; no series is needed.

**Frames / states drawn**

1. **Share · four ways** ("Reel pauses at 0:18 while the sheet is open"). `msheet[role=dialog][aria-label=Share]` over the dimmed black-hole Reel. Header: thumbnail, "**The edge you can't come back from**", "Black holes · Part 2 of 4 · Reel". Four `button.choice` rows (`span.ic` icon + `span.tx` title/subtitle):
   - **Send to a conversation**: "Drop it into a chat you already have"
   - **Explore with friends** (highlighted yellow as the primary): "Start a thread: this Reel, what comes next, and the chat together"
   - **Share a moment**: "From 0:18 — pick the part worth looking at" (→ H03)
   - **Copy link / Share elsewhere**: "Other apps get a public link"
   - **Cancel** (ghost)
2. **Send to a conversation** ("Single choice; 'Sent' only after the receipt"). **Back to share options** (‹), `b` title. `input.field[type=search]` "Search conversations". `mono` "RECENT". `role=radiogroup` of `label.prow` rows (`span.av`, `span.tx`, presence `span.pres`, `input.chk[type=radio]`): **Ravi** (● Online, selected), **Meera** (○ Recently active), **Model serving room** ("Room"). `label` "Add a note (optional)" + field "This is the bit I meant". **Send to Ravi** (pri; the label names the recipient). A dashed annotation box "AFTER THE SERVER CONFIRMS" shows the confirmation row "✓ **Sent to Ravi**" + **Open chat** (`btn.sm` → C02).
3. **Explore with friends** ("Pick people; presence is optional per person"). `label` "Thread name" + field "Black holes"; `input[type=search]` "Search friends by name or @handle"; "RECENT" checkbox rows: **Ravi** (Online, ✓), **Meera** (Recently active, ✓), **Kabir** "@kabir.r" (no presence, unchecked), **Jun** "@jun.w". Helper: "Friends can open it whenever they like. Everyone keeps their own place in the Reels." **Create thread · 2 friends** (pri; the count is live).
4. **Thread created** ("Lands in the new thread at your own position"). Thread header: Back, `b` "Black holes", "Asha, Ravi, Meera". **Compact episode navigator** `button.nchip`: "1 ✓" (aria "Part 1, you've watched it"), "**2 · current**" (`aria-current`), "3", "4". Player card (link "Play Part 2: …"): `tag.part` "Part 2 of 4", title, progress, "0:18". System line: "You started this thread · Ravi and Meera will see it in Talk". Prompt: "Say why you're sharing it — or just let the Reel speak." A dashed **What if…** chip (`btn.sm`). Composer: `label` "Message", field placeholder "Message Ravi and Meera", **Send** (`ibtn`, cobalt).
5. **Copied · elsewhere · unavailable** ("Cancel closes silently"). Toast `div.toast[role=status]` "✓ **Link copied** / Paste it wherever you like." Below it, the variant "THE REEL WAS WITHDRAWN": a card with `tag` "Unavailable", "This can't be shared — it was withdrawn", "Nothing was sent. Links you shared earlier now open an honest 'unavailable' page." **Close** (`btn.ink`).

**States in the notes:** sheet · picking (0 selected disables Create) · creating (busy) · created → thread · sent (receipt) · **send failed → retry same request** · copied · system share opened · cancelled (silent) · content withdrawn / private (blocked before any send).

**Not drawn:** **0-selected disabled Create**; **creating (busy)**; **send failed → retry**; **search with no results**; **no friends yet** (empty picker → F01 add friends); the **private-content block** ("can't share privately-held content"); the **system share sheet**; the **Scroll** origin variant (header "· Scroll" with a passage/anchor).

**Controls → semantics**

| Control | Contract |
|---|---|
| Sheet open | Obs `share.sheet_opened` only. **Opening is not sharing.** Reel paused underneath; closing resumes playback (an overlay, not a history entry). |
| Send to a conversation → pick → Send to Ravi | `POST /v1/shares` (authorised content share; `share.send{conversationId, assetRevision, anchor?}`), which creates the share record **and** a conversation card. Equivalent to `POST /v1/conversations/:id/messages` with a content card. "Sent" only after the receipt. Retry reuses the request ID. |
| Model serving room as a destination | Share into a room thread/feed. **Room participation cannot widen access to a private source asset (§17)**: the server must check that the asset is shareable to the room's audience. |
| Explore with friends → Create thread · N friends | `POST /v1/content-threads` `{parent: new conversation, members[], root: assetRevision (+anchor), name}` (`thread.create`). The blueprint routes creating a group conversation via `POST /v1/conversations` + the thread under it. One idempotent command with a receipt; retry never duplicates. New members receive a scope-aware invitation (C03). |
| Share a moment | → H03 snippet composer (`POST /v1/snippets`). |
| Copy link | Creates/gets a public share link (`POST /v1/shares` kind=link) → clipboard; obs `share.link_copied`. Native: system share sheet (`share.system_opened`). **External intent ≠ delivery.** |
| Cancel / Back / swipe-down | Closes silently (`share.sheet_cancelled`). |
| Search conversations / friends | Read of the user's conversations/friends (list endpoints not in §7: **gap**, see C01/F01). |

**Data:** share-target content header (thumbnail, title, series + ordinal, format), recent conversations (from actual communication history), friends (name, @handle, avatar), **presence word** (Online / Recently active / none) set by each person, selected count, thread name, note text.

**Components:** `msheet`, `choice` option rows (`ic`, `tx`), `prow` picker rows (`av` avatar, `tx`, `pres` presence with ● filled / ○ hollow dot, `chk` radio/checkbox), `field` inputs, receipt inset, `nchip` compact navigator chips, player card, system line, What if… dashed chip, composer, `toast`.

**Conflicts / flags**

- **Presence** ("Online", "Recently active") is allowed under §17 only if visibility-controlled and expiring. The design states "Presence is a word, set by each person in F02 — people who hide it show none". This is compliant. **It must never be combined with content** (it is not; good).
- **"Recent" ordering** must come from real communication history, not invented activity (§17). Kabir/Jun appear under "Recent" with no conversation shown. **Resolution:** label the list "Friends" when the order is not based on recent conversations.
- **Thread-created navigator "1 ✓"** is the caller's own viewed marker (good), and its aria-label "you've watched it" is caller-scoped.
- **The "Copy link" subtitle "Other apps get a public link"** must match the access policy: public previews contain only public metadata (H02).

---

## H02 · Share landing & invitation

- **Board:** 2174×1480. Five phone frames, drawn as a mobile web page: a `div.wbar` bar with the `a.wm` "KnowScroll" wordmark. Desktop: web landing at 1440 (V01).
- **Purpose:** what a shared link opens on the web or in the app. "The link resolves to a **current access decision for one exact revision**; private links reveal nothing — not even a title — until access is checked."

**Frames / states drawn**

1. **Public · signed out** ("Public metadata only"). Wordmark, **Sign in** (`btn.sm.ghost`). A poster card `div.poster` (cobalt, play button `aria-label="Watch the Reel"`), `tag` "Reel · 0:46", `mono` "Machine learning", `h2` "What one answer costs to serve". **Open in the app** (pri), **Sign in to keep it**.
2. **Private · access required** ("No title, no preview yet"). A dashed lock placeholder, `tag` "🔒 Private link", "Someone shared something with you / Sign in to see what it is. If this link was meant for you, it will open straight away." **Sign in** (pri).
3. **Available · signed in** ("Ravi sees the exact revision"). An avatar `span.av[aria-label="Signed in as Ravi"]` "R". Attribution row: avatar "A" "**Asha** shared this in your conversation". Poster with `tag` "Reel · starts at 0:12", "Machine learning", title. **▶ Open Reel** (pri), **Reply in Talk**.
4. **Revoked · withdrawn** ("Two honest reasons, one layout"). Two variants in one frame: "IF THE SENDER REVOKED IT · 🔒 **Asha stopped sharing this link** / It no longer opens for anyone she sent it to." and (dashed) "IF THE CONTENT WAS WITHDRAWN · ⊘ **This Reel was withdrawn** / It isn't available anywhere on KnowScroll now." Footnote "Neither state shows the old title or poster." **Go to KnowScroll** (pri).
5. **Corrected since shared** ("Opens the revised version"). Banner `tag.cor` "Corrected · 14 Oct" "This Reel was updated after Asha shared it. An earlier version said attention cost grows linearly; it grows roughly with the **square** of length." Poster "Why long prompts cost more". **Watch the revised Reel** (pri), **Back to Talk** (ghost).

**States in the notes:** public signed-out · private access-required · available (authorised) · expired/revoked by sender · withdrawn content · corrected since shared. "Open Graph/preview metadata exists only for public links; private previews are blank."

**Not drawn:** **expired** (time-limited link; "expired" is merged into revoked); **signed in but not authorised** ("This wasn't shared with you": the access-denied state for a logged-in non-recipient); **loading/resolving**; a **Scroll** share landing (passage anchor); a **content-thread invitation** link (C03 covers it in-app); **app-not-installed** behaviour (it is web-only here).

**Controls → semantics**

| Control | Contract |
|---|---|
| Page load | `GET /s/:shareToken` → the server returns the access decision `{public | private_required | authorised | revoked | withdrawn | corrected(newRevision) | denied}` + the permitted metadata only. Obs `share.landing_viewed{state}`. |
| Open in the app | Universal link with the same token (obs `share.open_in_app`). |
| Sign in / Sign in to keep it | A01 flow with the held destination (back to this landing, then the anchor). |
| Watch / Open Reel | `POST /v1/experience/navigate` (explicit target, anchor 0:12) → `activate`. "Opening the card starts Ravi's own exposure; **receiving it gives no consumption credit**." |
| Reply in Talk / Back to Talk | → `/conversations/[id]` (C02). |
| Watch the revised Reel | Opens the newest revision with the correction banner (never the old one silently). |
| Go to KnowScroll | Neutral entry (`/explore` or `/welcome`). |
| Save after sign-in | `POST /v1/actions` save (`encounter.save`). |

**Data:** for **public** links: format, duration, topic, title, poster. For **private** links before auth: nothing. **Authorised**: sharer name + context ("in your conversation"), the anchor start ("starts at 0:12"), title. **Corrected**: the correction note + new revision title.

**Components:** web bar (`wbar`, `wm` wordmark, avatar), `poster` card, lock placeholder (dashed), attribution row, revoked/withdrawn state cards (solid vs dashed), corrected banner.

**Conflicts / flags**

- **Route:** the design uses `/share/:token`; the blueprint uses `GET /s/:shareToken`. **Resolution:** follow the blueprint (`/s/[token]`) and do not reuse `/s/` for Scroll reader URLs (see E02).
- **The revoked copy names the sender ("Asha stopped sharing this link") to anyone holding the link**, possibly signed out. That leaks the sharer identity of a private link before access is checked. **Resolution:** signed-out or non-recipients see "The person who shared this stopped sharing it"; show the name only to an authenticated recipient who already had access.
- **"Sign in to keep it"** on the public preview is fine (no persisted guest identity).

---

## H03 · Share a moment · snippets (v2)

- **Board:** 2174×1480. Five phone frames. Desktop: the same flow in the D03 thread.
- **Purpose:** "'Look at this' becomes an exact place everyone can open: a short **range of a Reel**, a **passage of a Scroll**, or an **interactive block set the way you set it**. Snippets point at the original — no new video is made." This is §17 "Snippets are anchored references".

**Frames / states drawn**

1. **Reel · pick a moment** ("Range 00:18–00:31 of Part 2"). The Reel is above (caption "Past this line, even light can't climb back out."). Sheet `msheet[aria-label="Share a moment"]`: `b` "Share a moment", `mono` "00:18–00:31". A **filmstrip range selector** (thumbnail strip with a yellow-bracketed window; handle buttons `aria-label="Start of moment, 0:18"` and `"End of moment, 0:31"`). Seg `aria-label="Moment length"`: **Just 0:18 | A short range** (range pressed). `label` "Message" + field "Look at this moment:". Destination `tag` "To · Black holes thread". **Share** (pri).
2. **Scroll · select a passage** ("Native selection + one share action"). The Scroll reader (Back, seg Scroll), `mono` "BLACK HOLES · PART 3", `h2` "Why time slows near one", prose. The selected text is highlighted yellow ("Nothing goes wrong with the near friend's watch. Time itself runs slower down there, because gravity bends spacetime."). A floating dark `role=toolbar[aria-label="Selection actions"]`: **Share passage** (cobalt) · **Copy** · **Ask**.
3. **Block · share as set** ("Configuration travels with the card"). Block header `mono` "ATTENTION, SLOWLY · WHY SQUARED?". The block reads "Try a longer sentence · **4,096 words**", a **yellow square whose area shows the work** (n² visual), `label` "Sentence length" + `input[type=range][min=0][max=3][value=3]` (**four discrete stops**), result "**About 64× the work** for 8× the words." Sheet "Share this diagram": `label` "Include how I set it / Sentence length 4,096" + `button.sw[role=switch][aria-checked=true]`. A card preview `div.snip[aria-label="Preview of the card"]`: `mono` "DIAGRAM · ATTENTION, SLOWLY", "Try the diagram with sentence length set to 4,096", `tag` "Length 4,096". `tag` "To · Meera". **Share**.
4. **Snippets in the thread** ("Range · passage · block · corrected"). Thread header `div.chead` (Back to Talk, "Black holes", "Asha, Ravi, Meera"). `div.thread`:
   - me bubble (`bub.me`, cobalt) "Look at this moment:" + **Reel range card** `a.snip` (dark thumb): "Part 2 · 00:18–00:31 / The edge you can't come back from" **Play**
   - `span.who` Ravi: **passage card** "PASSAGE · PART 3 SCROLL / 'Time itself runs slower down there, because gravity bends spacetime.' / **Read in context**"
   - Meera: **block card** "DIAGRAM · ATTENTION, SLOWLY / Try the diagram with sentence length set to 4,096 / [Length 4,096] **Open as set**"
   - Ravi: **corrected · mapped** card (rust) `tag.cor` "Corrected · moment found": "Part 3 · now at 00:21–00:34 / Shared at 00:18–00:31; the same moment moved slightly." **Play**
   - Meera: **corrected · changed** card `tag.cor` "Corrected · moment changed": "This Reel was corrected and this moment changed / Part 4 now explains that evaporation takes far longer than the age of the universe." **Watch the revised Reel**
5. **Open a snippet** ("Back returns to the same spot in the chat"). A focused dark viewer: **‹ Back to thread** (`btn.sm.sp`), `mono` "SHARED BY YOU", the Reel playing with its caption, `mono` "00:18–00:31 OF PART 2", the title, a progress bar with the **range highlighted in yellow**, **↻ Replay** (`btn.sp`), **Watch from here** (`btn`).

**States in the notes:** picking · sending · sent · **failed → retry same request** · original corrected (compatible mapping → mapped range; no mapping → "moment changed", never plays the old range) · **original withdrawn** (the card stays, content "unavailable") · **block type changed** (falls back to default settings and says so).

**Not drawn:** **sending/failed** snippet; **withdrawn source** card; **access-denied** card (a recipient without access to the source; §17 "source access checked independently of thread membership"); **block type changed** fallback; the **Scroll passage open-in-context** view (highlighted passage on arrival); the **"Just 0:18"** single-moment card form; the **"Include how I set it" off** preview.

**Controls → semantics**

| Control | Contract |
|---|---|
| Share (Reel range) | `POST /v1/snippets` `{kind: reel_range, assetRevisionId, startMs, endMs}` → then `POST /v1/content-threads/:id/messages` (or conversation message) with the snippet reference and the message text. The design combines them as `snippet.share{threadId, assetRevision, start, end}`. A single idempotent client command is recommended, server-side two records. |
| Range handles / Just 0:18 vs A short range | Client-side range state; ←/→ ±1s, Shift ±5s; validated server-side within the duration. |
| Share passage (selection toolbar) | `POST /v1/snippets` `{kind: scroll_passage, articleRevisionId, blockId, textRange, quotedText}`; the server validates the quoted text. |
| Copy / Ask (selection toolbar) | Clipboard / E04 with "About this" scope + the selected passage as context. |
| Include how I set it (switch) | Whether `blockState` (an allowlisted parameter snapshot) is included: `POST /v1/snippets` `{kind: block, articleRevisionId, blockId, blockTypeVersion, params?}`. The card is labelled with the included settings ("Length 4,096"). |
| Play (range card) | Opens the snippet viewer (`/threads/[id]/snippet/[snippetId]`); plays the range only; obs `snippet.opened`, `reel.visible_interval` (range only). Opening/receiving is **not** a qualified encounter beyond the visible interval. |
| Read in context | Opens the Scroll at the passage (anchor = block + text range) with a highlight. |
| Open as set | Opens the block with the shared parameter snapshot applied (**the recipient's own block state is not overwritten** until they interact). |
| Watch the revised Reel | Opens the newest revision (the corrected, no-mapping case). |
| Back to thread | Closes the viewer and restores the thread message anchor + the user's own navigator place (not a separate history entry). |
| Replay | Replays the range. |
| Watch from here | Pushes the full Reel at 0:18 as a normal encounter/history entry (`POST /v1/experience/navigate` + `activate`). |

**Data:** snippet kind, source title, part ordinal, range (mm:ss–mm:ss), quoted passage, block title + parameter tags, sharer attribution (`span.who`, "Shared by you"), correction mapping state (`found` with new range / `changed` with one-line change note / `withdrawn` / `denied`).

**Components:** filmstrip range picker with handles, `seg` length mode, selection toolbar, `sw` switch row, `snip` snippet cards (variants: reel-range with dark thumb + Play, passage quote + Read in context, block + param tag + Open as set, corrected-found rust, corrected-changed rust), destination tag "To · …", snippet viewer (range-highlighted progress bar, Replay, Watch from here).

**Conflicts / flags**

- **Block settings default.** H03 draws "Include how I set it" **on**, while the open decision says "drawn as an opt-in toggle". §17: "label whether this state is included" and "another user's … hidden block data is not shared by accident". **Resolution:** default **off** for any block whose parameters include user-entered personal values (E09 weight), and default on only for allowlisted non-personal parameters. Always show the exact included values on the card (as drawn).
- **"Corrected · moment changed" one-liner** ("Part 4 now explains…") must be authored correction text, not model output.
- **Passage snippets quote text verbatim**, so the server must validate the quote against the article revision (§17).

---

## C01 · Conversation inbox ("Talk")

- **Board:** 1330×1480. Three phone frames. Desktop: D03 left column.
- **Purpose:** "**Real conversations only**: people, content threads and rooms. Optional 'Online' / 'Recently active' labels show availability, never what anyone is watching. **No activity counts.**"

**Frames / states drawn**

1. **Inbox · ready** ("Unread shown by dot + bold"). `h2` "Talk" + **New message** (`ibtn` +). `a.crow` rows (`span.avc` avatar/thumb, `span.ctx` text, `mono` time, cobalt unread dot):
   - **Ravi** · ● Online · "Shared a Reel · What one answer costs to serve" · 9:40 · unread (aria "Ravi, unread. Shared a Reel: …")
   - **Black holes** (content thread; black-hole thumbnail) · "Asha, Ravi, Meera · Ravi: That last part surprised me." · mini marks ▬▬○○ + `mono` "**YOU: PART 2**" · 9:52 · unread (aria "Content thread Black holes with Asha, Ravi and Meera. You are on Part 2. Unread.")
   - **Meera** · ○ Recently active · "You: the orbit Scroll is worth it" · Mon
   - **Model serving room** (square station glyph) · "Room · Moderator pinned a question" · Sun
   - The NavBar Talk tab shows a dot ("Talk •") for unread.
2. **Empty** ("First visit to Talk"). Two-bubble illustration, "No conversations yet / Share a Reel or Scroll with a friend and the conversation starts here." **Share something** (pri → Explore), **Invite a friend** (→ F01).
3. **Offline · cached** ("Writing still allowed, queued"). Banner `role=status` "Offline. This list may be out of date. Messages you write will send when you're connected." Rows are dimmed **without presence** labels. A dashed queue chip "🕐 **1 message waiting to send** · to Ravi".

**States in the notes:** loading (row skeletons) · ready · empty · offline (cached, dimmed, "may be out of date") · reconnecting (same banner, "Reconnecting…") · queued outgoing count from the real local queue.

**Not drawn:** **loading skeletons**, **reconnecting**, the **long-press Mute/Leave** menu, a **pending thread invitation** row (drawn on C03), the **New message** composer/picker.

**Controls → semantics**

| Control | Contract |
|---|---|
| Row → person | `/conversations/[id]` (C02); `GET /v1/conversations/:id/messages?after=cursor`. |
| Row → content thread | `/threads/[id]` (C04); `GET /v1/content-threads/:id`. |
| Row → room | `/rooms/[id]` (R02); `GET /v1/rooms/:id`. |
| New message (+) | Friend picker → `POST /v1/conversations` (create/accept an authorised conversation). |
| Long-press → Mute / Leave | Conversation/thread notification setting / leave (`conversation.mute/leave`, `thread.mute/leave`). **Gap:** no blueprint route for mute/leave; group under "conversation commands" (`POST /v1/conversations/:id/mute`, `/leave`). |
| Share something / Invite a friend | → `/explore` / `/friends` (F01). |

**Data per row:** title (person name / thread name / room name), avatar or content thumbnail or station glyph, presence word (people only, honouring the person's setting), last authorised message preview with author prefix ("You:", "Ravi:"), **the caller's own thread position** ("You: Part 2"), time, unread (from the server read cursor), room event ("Moderator pinned a question").

**Backend:** **gap:** §7 has no `GET /v1/conversations` (list) route. Add `GET /v1/inbox?cursor=` returning conversations, content threads and rooms with last authorised message, own position and unread. Presence comes via Socket.IO (expiring).

**Components:** `crow` inbox row (`avc` avatar circle / square room glyph / content thumb), presence label (dot + word), unread dot + bold, mini part marks + "YOU: PART N", offline banner, queued-outgoing chip, empty state, NavBar badge dot.

**Conflicts / flags**

- **"You: Part 2" on the thread row is the caller's own position.** Compliant. **No peer positions appear.** Good.
- **Presence "Online" shown in the inbox** alongside the row: allowed (availability, not content). It is hidden in the offline state (correct, since it would be stale).
- "No pinned AI chat, no suggested strangers": compliant.

---

## C02 · Conversation detail (1:1)

- **Board:** 1752×1480. Four phone frames. Desktop: D03 centre.
- **Purpose:** Asha ↔ Ravi. "A plain 1:1 conversation: messages, exact content cards, and **'Start a thread'** to turn a shared Reel into a content thread (C04). A failed message stays one bubble; reconnect fills gaps in order."

**Frames / states drawn**

1. **Thread · ready** ("Card, replies, typing, Start a thread"). Header `div.chead`: **Back to Talk** (‹), `span.avs` "R" **Ravi**, **Start a thread** (`a.btn.sm`, aria "Start a thread from the shared Reel"), **More options** (⋯). `div.thread`: `span.sysl` "Today"; mine: content card `a.cardm` (cobalt poster; `tag` "Reel · from 0:12"; "What one answer costs to serve"; "Machine learning"; aria "Reel: …, starts at 0:12") + bubble `bub.me` "This is the one I meant. The bit at 0:12." + `mono` "SENT"; theirs `bub.them` "Wait, so batching makes each answer slower?"; mine "A little — that's the trade." SENT; a typing indicator `div.theirs[role=status]` "Ravi is typing •••" (dashed). Composer `div.comp`: `label` "Message Ravi", input, **Send** (`ibtn`, cobalt).
2. **Failed → retry** ("One bubble; same request ID, no duplicate"). `mono` "BEFORE RETRY": a bubble with a rust outline "Let's ask what happens at 10×" + "Not sent" + **↻ Retry** (`btn.sm`). Dashed divider; `mono` "AFTER RETRY · SAME BUBBLE": the same bubble, now cobalt + SENT.
3. **Reconnect · catch-up** ("Missing messages arrive in order"). Banner `role=status` "◌ **Reconnecting…** Missing messages will appear in order." A divider "**WHILE YOU WERE AWAY**", then two theirs bubbles and a theirs **withdrawn card** (dashed, `tag` "Unavailable", "This Reel was withdrawn / The message stays; the content doesn't.").
4. **⋯ sheet · membership lost** ("Block, report, mute, leave"). Sheet `msheet[aria-label="Conversation options"]`: `mono` "CONVERSATION WITH RAVI", **Mute notifications**, **Report a message**, **Leave conversation**, **Block Ravi** (rust). Explanatory "Blocking stops new messages and shared links between you. Ravi isn't told." Variant "MEMBERSHIP LOST": banner "🔒 **You're no longer in this conversation.** You can't send messages or open its shared items."

**States in the notes:** loading · ready · typing (real signal only) · sending · sent · failed → retry · offline queued · reconnecting → catch-up divider · withdrawn card inside a bubble · blocked · membership lost (composer removed).

**Not drawn:** **loading**, **sending** (pending bubble), **offline queued bubble**, the **blocked** state (after blocking: composer state, history), the **empty new conversation**, the **Report a message** flow (P03 covers content/abuse), the **long-press message menu** (reply / report / share a moment), **corrected card** inside a bubble.

**Controls → semantics**

| Control | Contract |
|---|---|
| Send | `POST /v1/conversations/:id/messages` `{requestId, text | contentCard}` → attributed message + receipt + cursor. The bubble shows SENT only after the receipt. |
| Retry | Same endpoint, **same requestId** (`message.retry{sameRequestId}`); the server dedupes. |
| Reconnect | Socket.IO reconnect → `GET /v1/conversations/:id/messages?after=cursor` (catch-up ordered by server sequence; the view does not jump). |
| Content card tap | Opens the content as the **viewer's own encounter** at the anchor (`/reel/[id]?t=12`) → `navigate` + `activate`. |
| Start a thread | `POST /v1/content-threads` `{parent: conversationId, root: cardAssetRevision}` (members = this conversation; no new invite needed). Or pick more people via H01. |
| ⋯ Mute / Leave | Conversation commands (gap; see C01). |
| Report a message | P03 abuse report (`report.message`). |
| Block Ravi | `block.user`, a privacy/social command. **Gap:** not in §7; the F01/F02 area needs `POST /v1/blocks`. |
| Typing | Socket.IO typing signal (ephemeral, not durable). |

**Data:** messages (author, text, server time/sequence, delivery state SENT / Not sent), content cards (format, anchor "from 0:12", title, topic, availability), system lines ("Today", "While you were away"), typing state, membership state.

**Components:** `chead` header (`avs` avatar), `thread` list, `bub.me` (cobalt) / `bub.them` (outlined) bubbles, `mono` delivery state, `cardm` content card (cobalt poster + white body), failed bubble (rust outline) + Retry, catch-up divider, reconnecting banner, typing bubble (dashed), withdrawn card (dashed), options sheet, membership-lost banner, `comp` composer.

**Conflicts / flags:** compliant. "Blocking … Ravi isn't told." matches the privacy posture. **Blueprint gap:** block/report/mute/leave need routes.

---

## C03 · Thread invitation & membership (v2)

- **Board:** 1330×1480. Three phone frames. Desktop: inline in D03.
- **Purpose:** "You can look before you join. **Joining is one clear tap on Join thread; Ignore hides it quietly.** What's shared is stated once, plainly." v2.1 product decision: "preview first, no separate accept/decline ceremony; Ignore hides it without telling Asha."

**Frames / states drawn**

1. **Received · Ravi's Talk** ("Preview to look · Join to join · Ignore hides"). The Talk list with a pinned **new-thread card** `section[aria-label="New thread"]` (yellow offset shadow): thumbnail, `mono` "NEW THREAD", "**Asha started a thread · Black holes**", "with you and Meera · 4 Reels"; a scope line `div.sysl` "🔒 Your universe and history aren't shared. You keep your own place in each Reel."; link **Preview the thread**; **Join thread** (pri), **Ignore** (ghost). Normal rows below (Asha ● Online "You: Did Part 2 load for you?"; Kabir "Kabir: see you at the match").
2. **Members sheet** ("Presence words only if each person allows"). Over the thread: `msheet[aria-label="People in this thread"]` with `div.mrow` rows: **Asha** "● Online · started this thread"; **Ravi (you)** "Your status: Online · [change]" (→ F01/F02 visibility); **Meera** "○ Recently active". Note: "Status says whether someone's around — never what they're watching." **+ Add people**, a **Mute this thread** switch (`button.sw[role=switch]`, "Still in your Talk list, no alerts"), **Leave thread** (rust outline).
3. **Ended · left · withdrawn** ("Honest lines, no error pages"). Thread header + compact chips 1 / 2 / **3 (dashed = withdrawn)** / 4. Banners: "ITEM WITHDRAWN · **Part 3 is no longer available.** It was withdrawn after this thread started. Messages that mention it stay." / "THREAD ENDED BY ASHA · 🔒 **Asha ended this thread.** You can still read the conversation. Its Reels open from your own Explore or Keep, not from here." / "YOU LEFT · **You left this thread.** To come back, someone in it can add you again." + "Anything you watched while you were here still shapes only your own universe."

**States in the notes:** new · previewing (not a member) · joined · ignored (hidden; can still be found under Hidden) · muted · left · removed · ended by starter · item withdrawn/corrected · blocked person can't be added (no hint why). People who hide status show no label.

**Not drawn:** the **preview mode** of C04 (read-only: "no messages sent, no presence shown"); **removed** (by starter); the **invitation revoked before join** (§18 "Explore invitation: pending, accepted, declined, **revoked**"); the **Hidden** list (ignored invitations); the **Add people picker** (reuses H01, respecting blocks); the **Leave confirmation sheet** (described: "destructive action with its own confirmation sheet").

**Controls → semantics**

| Control | Contract |
|---|---|
| Preview the thread | `GET /v1/content-threads/:id?preview` (read-only, permission-checked invitation scope; no presence, no messages sent). |
| Join thread | Accept the scope-aware invitation (`thread.join`). §7 has no explicit join route: **gap**. Propose `POST /v1/content-threads/:id/join` (idempotent). It lands at Part 1 as a member. |
| Ignore | `thread.ignore`: hides the invitation without notifying the sender (gap; `POST …/ignore`). |
| Add people | `thread.add_member{handle}` (`POST /v1/content-threads/:id/members`; it respects blocks with no hint why). |
| Mute this thread | `thread.mute` (notification preference). |
| Leave thread | `thread.leave` (with confirmation). |
| change (own status) | → F01/F02 presence visibility. |
| End thread / remove member | `thread.end`, `thread.remove_member` (starter-only; not drawn as controls). |

**Data:** inviter name, thread name, other members, item count ("4 Reels": a content count), privacy scope line, member list with presence words and roles ("started this thread", "(you)"), membership/withdrawal state lines.

**Components:** new-thread invitation card (yellow shadow region), scope line `sysl` with lock, members sheet `mrow`, `sw` switch row, destructive outline button, compact chips with a dashed withdrawn chip, state banners.

**Conflicts / flags**

- **Join/Ignore replaces accept/decline.** §18 lists "Pending, accepted, declined, revoked". The v2.1 decision maps declined → **Ignore (silent)**. That is behaviourally compatible (declined, not reported to the sender), but the server must model `ignored` and also **revoked** (the starter removes a pending invite), which has no drawn state.
- **"Thread ended by Asha"** introduces a thread lifecycle (`ended`) that §17 does not define. **Resolution:** add `ended` to the thread root state; after the end, messages are read-only and items open only via the user's own routes (as drawn).
- **"4 Reels"** is a count of content, not consumption. Acceptable.

---

## C04 · Content thread (v2 / v2.1) — the integrated surface

- **Board:** 2596×1480. Six phone frames. Desktop: D03 (content beside the conversation).
- **Purpose:** "The sequence and the conversation on one screen. An **episode browser** with real thumbnails and short titles shows **your own** place; **collapsing the player pauses it**; Like, Save, Share moment and Full screen are always one tap away. Works when everyone arrives at different times." This is §17's integrated content thread: header/participants → episode navigator → collapsible encounter → messages/inline cards → composer.

**Frames / states drawn**

1. **Expanded · Asha** ("Player · actions · episode browser · talk"). Header `div.chead`: Back to Talk, `span.htx` "**Black holes** / Asha, Ravi, Meera · ● Ravi online", **Members** (`ibtn` people icon → C03 sheet). **Player** `div.player` (dark): `tag.part` "Part 2 of 4", **Collapse player (pauses)** (`ibtn.sp`, chevron-down), controls `div.pctl` (**Pause** `mbtn`, title "The edge", progress `div.pbar`, `mono` "0:23"). **Action strip** `div.astrip[role=toolbar][aria-label="Actions for Part 2"]` with `.act` buttons: **Like** · **Saved** (pressed, yellow bookmark) · **Share moment** (→ H03) · **Full screen** · **More** (aria "More: keep listening, report"). **Episode browser** `div.eprow[role=group][aria-label="Episodes in this thread"]`, horizontally scrollable `button.ep` cards (thumbnail + `span.lb` "Part N" + short title + marker `span.mk`): **Part 1 · What it is ✓** (aria "…, watched"); **Part 2 · The edge · Now** (`ep.now`, `aria-current`, cobalt outline, yellow "Now" badge); **Part 3 · Time slows**; **Part 4 · Forever?** (cut off at the right edge to show it scrolls). Conversation `div.convo`: `span.who` Ravi + `bub.them` "That last part surprised me."; `bub.me` "Look at this moment:" + snippet `a.snip` "Part 2 · 00:18–00:31 · The edge · Play" (aria "Play Part 2 from 0:18 to 0:31"); a dashed `button.wif` **What if…** chip. Composer "Message Ravi and Meera" + Send.
2. **Collapsed · paused** ("Folding pauses; numbered chips"). The navigator becomes **compact chips** `div.ncr[role=group][aria-label="Episodes, compact"]`: `nc` "1 ✓" (aria "Part 1, watched"), `nc.cur` "**2 · now**" (`aria-current`), `nc.up` "3", "4". A **mini bar** `div.mini`: `span.mt` "Part 2 · The edge / Paused at 0:23", `mbtn` **Play**, **Expand player** (^), **More** (⋯). A longer conversation (Meera, Ravi, snippet, Meera, me "Part 3 is about exactly that — time slowing."), the What if… chip and the composer.
3. **Keep listening · chosen** ("Audio only, via ⋯"). Mini bar in cobalt: 🔊 "**Listening · video hidden** / Part 2 · The edge · 0:31", **Pause**, **Expand player and show video**, **More**. A switch row `role=switch` "**Keep listening while chatting** / Audio only. This isn't counted as watching." (on).
4. **Keyboard open** ("Player folds; composer, context, Play stay"). Mini bar "Part 2 · The edge / Paused at 0:23" + Play + More; the last messages and the snippet stay readable; the composer has a focused field "So the edge isn't a surface at all?" above a hatched **system keyboard placeholder** `div.kb` ("SYSTEM KEYBOARD · ≈ 300–340PX").
5. **Episode browser · all states** ("'All in this thread' grid"). A full sheet: **Close** (×), "**All in this thread** / Black holes · markers show your own viewing". `mono` "PARTS · IN ORDER": a grid of the four `ep` cards (✓, Now, none, none). `mono` "BEING PREPARED · NOT PLAYABLE YET": `div.ep.prep[role=status]` (dashed, hatched) "NEXT PART / **Preparing** / Ravi asked for it". `mono` "ALSO IN THIS THREAD": `button.ep.persp` "ANOTHER PERSPECTIVE / **Black holes as an information puzzle**"; `button.ep.wif` (cobalt dashed) `tag.hyp` "**Speculative**" "**What if · a black hole were a portal**". Legend `span.lg`: "✓ You watched it · [Now] Where you are · — No mark: not watched by you yet · Dashed: preparing, can't play yet".
6. **Arriving later · Meera** ("Her own start; only her markers"). Player at `tag.part` "Part 1 of 4" with **▶ Start here** (`btn.sp.sm`); the action strip (Like/Save/Share moment/Full screen/More); browser with Part 1 "Start" badge (aria "Part 1, What it is, start here"), the others unmarked. System line `sysl` "**Asha added you · watch in any order, at your own pace**". Conversation: Ravi's message; Asha's snippet card "Part 2 · 00:18–00:31 / **Opens just that moment** / Play". Composer "Message Asha and Ravi".

**States in the notes:** **Rule: collapsing pauses.** Keyboard opening collapses (and so pauses). Keep listening is an explicit ⋯ choice: audio only, video hidden, not counted as watching. Card states: watched ✓ · Now · no mark · Preparing (separate, dashed, not selectable) · perspective / what-if items with their own titles, never numbered. Loading, offline (cached), withdrawn/corrected items as in C03/H03.

**Required by §17/§18 but NOT drawn:** a **Scroll as the thread item** (the encounter area showing an article: collapsed/expanded reading, anchor). **Every C04 frame is a Reel**, yet §17 says a thread can start with one Reel *or* one Scroll. **Single-item thread** ("one card plus 'Continue this', which becomes a Preparing card when requested", described only). **Full-screen player** and its exact return. **Loading** / **offline cached** thread. **Membership loss while viewing** (only in C02/C03). **Corrected item** in the browser. **Message sending/failed** inside the thread (C02 pattern). **Typing** in a group thread. **Preview (not yet a member)** mode.

**Controls → semantics**

| Control | Contract |
|---|---|
| Open thread | `GET /v1/content-threads/:id` (ThreadView: permission-filtered episode/message windows, branch summaries and **own resume state**). Socket.IO `subscribe_scope` for live notices. |
| Episode card / chip tap | `thread.select_item{itemId}`: a client selection that opens the item at **the caller's own** anchor. Then `POST /v1/experience/navigate` (explicit target) + `activate` when playback starts. Selecting is **not** consumption. |
| Collapse player (pauses) / keyboard open | Client player state: pause and keep the playhead; `reel.visible_interval` stops. Design `thread.player.collapse` is a client event (no server command needed). |
| Expand / Play (mini bar) | Resume (paused → playing); no auto-resume after the keyboard closes. |
| Keep listening while chatting | Client audio-only mode; **audio-only time is not `reel.visible_interval`** (an observation-schema rule). |
| Like / Saved | `POST /v1/actions`. |
| Share moment | H03 → `POST /v1/snippets` + `POST /v1/content-threads/:id/messages` (snippet reference). |
| Full screen | Full-screen encounter with exact return to the thread (one active player). |
| More (⋯) | Keep listening, Report (P03). |
| Snippet Play | Snippet viewer (H03-5). |
| What if… chip | X01 exploration composer (`POST /v1/explorations`). |
| Composer Send | `POST /v1/content-threads/:id/messages` `{requestId, text}`. |
| Members icon | C03 members sheet. |
| See all (described) | "All in this thread" grid. |
| Start here (late joiner) | Begin Part 1 as her own encounter. |

**Data per episode card:** stable item id + revision, ordinal ("Part N", declared series only), distinct thumbnail, short title, format, **caller-only marker** (✓ watched / Now / none / Start), supply state (ready / **Preparing** + contribution attribution "Ravi asked for it"), relationship kind (series part / Another perspective / What if + `tag.hyp`). Header: thread name, member names, presence for others (word). Mini bar: current item + own playhead.

**Gestures / transitions:** the **episode strip owns horizontal drag** (it must not navigate the feed); the message list owns vertical scroll; the player collapse animates (folds) and the navigator morphs cards → chips; the keyboard pushes the composer. Platform Back: closes full screen → thread; thread → Talk.

**Components:** `chead` + `htx` + presence, `player` (`pctl`, `mbtn`, `pbar`), `astrip` action toolbar (`act`), `eprow` episode browser (`ep`, `ep.now`, `ep.prep`, `ep.persp`, `ep.wif`, `lb`, `mk`, `mk.now`), compact `ncr` chips (`nc`, `nc.cur`, `nc.up`), `mini` bar (`mt`), keep-listening switch row, `convo` (`who`, `bub.them`, `bub.me`, `snip`, `sysl`), `wif` What-if chip, `comp` composer, `kb` keyboard placeholder, grid sheet with legend (`lg`).

**Conflicts / flags**

- **No peer playback:** compliant. Markers are explicitly the caller's own ("markers show your own viewing"; "Others' positions are never sent"). **However,** user-authored messages can still say "Listening to Part 2 again" (fine; it is human speech, not system broadcast).
- **"Preparing · Ravi asked for it"** is the allowed contribution-history form (§17 "Ravi requested More instances").
- **Label inconsistency: "Speculative"** (`tag.hyp`) on the what-if card vs "**Hypothetical**" elsewhere (X01–X03, Main's "only two epistemic labels survive: Hypothetical and Corrected"). **Resolution:** use **Hypothetical** as the single epistemic label. "Speculative" may appear only as explanatory copy (X01 confirm path).
- **"Ravi online" in the thread header** is availability only. Fine if F02 allows. It must not be combined with the item he is on.
- The **Scroll-in-thread surface is undrawn**. The implementer must design the collapsed/expanded reading state from E02/E03 parts (anchor kept; collapse = reading position kept).
- The **"Speculative/What if" card in "Also in this thread"** must not imply generated content exists if it is only a suggestion (§18 branch history "no implication every suggested node has generated content"). The design shows it as a selectable card. **Resolution:** distinguish `suggested` (not commissioned) from `admitted` branch items in the card state.

---

## X01 · What if… from the conversation (v2)

- **Board:** 1330×1480. Three phone frames. Desktop: D03 right column.
- **Purpose:** inline exploration input. "A clear request goes straight through with a short summary you can edit. Only ambiguous or speculative ideas ask you to confirm assumptions first — casual talk shouldn't feel like configuring a simulation." v2.1 decision "quick what-if".

**Frames / states drawn**

1. **Quick path · clear request** ("Summary shown, Explore submits"). Over the "Serving costs" thread (Asha, Ravi): sheet `msheet[aria-label="Start a what-if"]`. Seg `aria-label="Kind of exploration"`: **What if…** (pressed, branch glyph) | **Another perspective** (lens glyph). A source selector `button.tag` "FROM: THE WHOLE THREAD ⌄". `label` "Your idea" + `textarea` (dashed cobalt) "Show what happens with ten times the traffic, keeping the same model." A summary box `mono` "WE'LL EXPLORE" + **Edit** link; chips `span.sum.ch` "**Changed: traffic ×10**" (cobalt dashed) and `span.sum.kp` "**Kept: same model**" (outlined). **Explore** (pri, branch glyph). Helper "You can change the assumptions after it starts."
2. **Quick path · in the thread** ("Branch card preparing; still editable"). Thread header "Serving costs / Asha, Ravi". Item bar `nav.epbar[aria-label="Items in this thread"]`: `ep.cur` "1 · current", `ep.br` (cobalt dashed) "⚑ Traffic ×10 · Preparing". Mini player "What one answer costs to serve / PAUSED 0:41" + Expand. Conversation: Ravi "What would actually break first if traffic jumped?"; **branch card** `section.brc[aria-label="What-if branch"]` (cobalt dashed, light-cobalt fill): `tag.hyp` "⚑ WHAT IF" + "Asked by you", `b` "**Ten times the traffic, same model**", summary chips (Changed/Kept), a preparing chip `span.prep` (striped spinner) "Preparing the first Reel", **Edit assumptions** (`btn.sm`), **Cancel** (ghost); Ravi "Nice — that's exactly my question."; composer "Message…".
3. **Confirm path · speculative** ("Only for unclear or speculative ideas"). **Back to your idea** (‹), `tag.hyp` "WHAT IF" + "Black holes thread", `h2` "What if a black hole were a portal?". Yellow banner "ⓘ **Speculative scenario · not established science.** A quick check first, so the branch compares the idea with what physics actually says." `mono` "CHANGED": an editable chip `button.chip` (cobalt dashed, pencil) "A black hole connects to somewhere else". `mono` "KEPT": removable chips "Gravity outside works as usual ×", "Same black hole as Part 2 ×", and "+ Add" (dashed). "Everyone in this thread will see the branch. Each of you opens it at your own pace." **Create branch** (pri), **Cancel**.

**States in the notes:** composer empty · typing · summary forming (shown once the idea is clear) · clear → Explore · unclear → one question or confirm step · speculative label required · branch preparing / ready / failed (X02) · offline (draft kept, Explore disabled with reason).

**Not drawn:** **composer empty**, **summary forming** (live parse), **unclear → one clarifying question** (the `scenario.clarify` path), **Another perspective** composer (lens naming), **offline disabled**, **entry from a snippet card** or from a **message ⋯ menu** ("From: …" variants), **Explore pending/committing**.

**Controls → semantics**

| Control | Contract |
|---|---|
| What if… / Another perspective seg | Exploration kind: `what_if` (changes assumptions) vs `perspective` (changes the lens). §17 "Four continuation relationships". |
| From: the whole thread ⌄ | Exploration source scope: thread root / snippet / message (§17 "from the root, a snippet or a message"). |
| Your idea (text) + summary chips | The server (Scenario Planner via harness) parses into `{changed[], kept[]}`; "summary computed locally; nothing sent until Explore" per J2 step 6. **Conflict:** parsing natural language into assumptions requires the model (server). See flags. |
| Explore (quick path) | `POST /v1/explorations` `{threadId, source, kind, text, assumptions, direct: true}` → exploration root + `POST /v1/explorations/:id/branches` (explicit selected request → ContentDemand). Idempotent receipt. |
| Create branch (confirm path) | Same, with user-confirmed assumptions + `hypothetical/speculative` status. |
| Changed / Kept chips (edit ×, + Add) | Edit the assumption list before commit. |
| Edit assumptions (on the card) | "Assumptions stay editable on the branch card until content is made." **Behaviour must be:** cancel the in-flight demand and request a new branch (new node), never mutate a commissioned request in place. |
| Cancel (on the card) | `branch.cancel` (cancel the demand). **Gap:** no blueprint route; propose `POST /v1/explorations/:id/branches/:branchId/cancel`. |

**Data:** exploration kind, source scope, the user's idea text, parsed changed/kept assumptions, epistemic status (hypothetical; speculative "not established science"), requester attribution ("Asked by you"), preparation state ("Preparing the first Reel").

**Components:** kind `seg`, source selector tag, textarea, summary box with `sum.ch` (changed, cobalt dashed) / `sum.kp` (kept, outlined) chips, `brc` branch card (cobalt dashed), `prep` preparing chip, `epbar` item bar with branch item `ep.br`, speculative banner (yellow), editable/removable assumption `chip`s, Add chip.

**Conflicts / flags**

- **"Summary computed locally"** (J2 step 6 note) conflicts with §15/§17: assumption extraction is a Scenario Planner (harness) job, server-side. A client cannot reliably compute "Changed: traffic ×10". **Resolution:** add a cheap server "draft/preview" command (e.g. `POST /v1/explorations/draft` returning a structured summary with no production commission) or a client-side template parser for simple cases. Commissioning still happens only on Explore.
- **No internal prompts or model reasoning are exposed.** The summary chips are structured outputs. Compliant. The speculative banner copy is fixed product copy. Good.
- **Hypothetical labelling:** the card uses `tag.hyp` with text "What if". §17 requires hypothetical status to persist through continuations. Make sure the X03 branch items also carry it (they do: "Hypothetical").

---

## X02 · Branch cards in the conversation (v2)

- **Board:** 1330×1480. Three phone frames. Desktop: D03 conversation column.
- **Purpose:** "A chosen idea becomes a card in the same chat. **What-if cards are dashed cobalt with a branch mark; perspective cards are solid with their own title. Neither is numbered as a part.**"

**Frames / states drawn**

1. **Ready · two kinds** ("Shapes differ, not just colour"). Thread "Black holes" with compact chips `nav.epbar` "1 ✓ · 2 · current · 3 · 4". Ravi "So nothing gets out. Where does it go though?". **What-if card** `article.brc` (dashed cobalt): `tag.hyp` "⚑ WHAT IF" + `tag.spec` "**SPECULATIVE**" (yellow), `b` "What if a black hole were a portal?", cobalt copy "Speculative scenario · not established science. Kept: gravity outside works as usual.", attribution "Started by Asha from the thread", `a.go` **Explore this →**. Meera "I'd rather know what physicists actually argue about." **Perspective card** `article.pvc` (solid, ink offset shadow): `mono` "⊙ ANOTHER PERSPECTIVE", `b` "Black holes as an information puzzle", "Started by Meera from Ravi's message", **Explore this →**.
2. **Preparing** ("Explicit status; chat keeps going"). The what-if card with a `role=status` chip "◌ Preparing the first Reel" + "We'll post here when it's ready." A reply-to-card row: "Ravi · replying to the branch" + a quote line "What if a black hole were a portal?" + bubble "Can it explain why people keep saying 'wormhole'?"; Asha (me) "That's exactly what I want it to sort out."; Meera "Watching Part 3 meanwhile."
3. **Failed · dismissed** ("Honest, nothing invented"). The what-if card (rust dashed): "↻ **Couldn't prepare this branch**", **Try again** (pri), **Remove** (ghost). System line `sysl` "Asha removed a suggestion · nothing was made". A **suggestion card** (grey dashed): `mono` "SUGGESTION · NOT MADE", "What if the Sun became a black hole?", **Make this one instead** (`btn.sm.ghost`). Ravi "No rush, the chat's still here."

**States in the notes:** proposed · preparing (explicit, no %) · ready · failed (retry/remove) · removed · suggestion not made · speculative label · source content withdrawn (the card stays and says the root is unavailable).

**Not drawn:** **source withdrawn** card; a **non-speculative** what-if card in the ready state (only the speculative one is drawn ready; X01-2 shows the plain one preparing); a **ready perspective** card's preparing/failed states; an **AI-suggested** card (R02 draws it in a room).

**Controls → semantics**

| Control | Contract |
|---|---|
| Explore this | Open the branch sequence (X03): `GET /v1/explorations/:id` (permitted graph + **own position**) → select the branch's first item → `navigate`/`activate`. "**Anyone can open; nobody is moved when someone else does.**" |
| Try again | Retry the same branch request (`branch.retry{sameRequestId}`); no duplicate demand. **Gap:** no retry route (see E07). |
| Remove (creator) | `branch.remove` (gap). |
| Make this one instead | Select a suggestion → `POST /v1/explorations/:id/branches` (explicit selected request). |
| Reply to the card | `POST /v1/content-threads/:id/messages` `{replyTo: branchId}` (`message.reply{target}`). |
| Card status updates | Socket.IO `scope_changed` → re-read; the receipt `branch.ready` updates the card in place (never jumps the chat). |

**Data per card:** kind (what-if / perspective / suggestion), epistemic tags (What if + Speculative), title, assumptions one-liner ("Kept: …"), origin attribution ("Started by Asha from the thread", "Started by Meera from Ravi's message"), state (proposed / preparing / ready / failed / removed / not made), and source availability.

**Components:** `brc` what-if card (dashed cobalt; failed = rust dashed), `pvc` perspective card (solid + ink shadow), `tag.hyp`, `tag.spec`, `go` link, status chip, reply-quote row, `sysl` system line, suggestion card (grey dashed).

**Conflicts / flags**

- **Epistemic label taxonomy is inconsistent across boards:** "What if" (`tag.hyp`) + "Speculative" (`tag.spec`) here; "Speculative" alone on C04-5; "Hypothetical" on X03 (see below); Main says only "Hypothetical" and "Corrected" survive. **Resolution:** two stored statuses, `hypothetical` (every what-if branch and its continuations, §17) and `speculative` (a premise contrary to established knowledge, a subset). Render "What if · Hypothetical" always, plus "Speculative" when applicable. Fix the C04 grid to use the same tags.
- **"Meera: Watching Part 3 meanwhile."** is user-authored chat, which is fine. **The system must never auto-generate such lines** (§17 "must not imply 'Ravi is currently watching Part 1'").
- **The "Suggestion · not made" card** correctly marks it uncommissioned (§17 "Suggested branch … no episode number or generated-content claim").

---

## X03 · Exploring a branch (v2)

- **Board:** 1752×1480. Four phone frames. Desktop: branch items replace the navigator column (D03).
- **Purpose:** "Opening a branch **swaps the navigator for the branch's own items** and keeps a **one-tap way back to the original sequence at your position**. Discussion can stay in the branch or the whole thread."

**Frames / states drawn**

1. **Branch opened** ("Own items, clear way back"). Header `div.thead`: "Black holes" + cobalt sub-title "What if · a black hole were a portal". `nav.epbar[aria-label="Branch items"]`: a yellow **return chip** `a.retchip` "← Part 2 · 0:18" (aria "Back to Black holes, Part 2 at 0:18"), `ep.br.cur` "1 · current" (cobalt), `ep.br` "2" (dashed cobalt). A persistent banner `div.brc` (`tag.hyp` WHAT IF + `tag.spec` SPECULATIVE + "Speculative scenario · not established science"). A dark Reel (black hole with a dashed "portal" path), rail **Like · Save · Share** (aria "Share a moment"), caption "If one were a doorway, it would need a wormhole — allowed on paper, never observed.", `mono` "**BRANCH · 1 OF 2**", `h2` "Portal, or one-way door?", "0:14 / 0:46". A bottom bar button **💬 Talk about this branch**.
2. **Branch discussion** ("Scoped chat, toggle to whole thread"). The same header/epbar; mini bar "Portal, or one-way door? / BRANCH 1 · PAUSED 0:14" + Expand. Seg `aria-label="Show messages from"`: **In this branch** (pressed) | **Whole thread**. Messages (Ravi, Asha, Meera) and the system line "Messages here stay with this branch". Composer "Message this branch…".
3. **Perspective · try another** ("Solid style; new assumption from here"). Header "Black holes / Another perspective"; epbar: return chip "← Part 2 · 0:18", `ep.cur` (solid black) "Information puzzle". A **Scroll**: `mono` "⊙ A SCROLL · ANOTHER PERSPECTIVE", `h2` "Black holes as an information puzzle", prose. An inline box `div.brc` "TRY ANOTHER ASSUMPTION": `label` "What if" + input "What if the book's information leaked out slowly?", **Continue** (pri), **Not now**.
4. **Back to the original** ("Your own position, cards marked"). The original thread: chips "1 ✓ · 2 · current · 3 · 4"; mini bar "The edge you can't come back from / PART 2 · PAUSED 0:18" + Play. The what-if card is now marked `mono` "**OPENED BY YOU**" with `a.go` "**Resume at branch 1 · 0:14 →**"; the perspective card is also "OPENED BY YOU". Ravi "Back on Part 3 now."; composer.

**States in the notes:** branch item ready · **next item preparing** (explicit) · **speculative banner persistent on every item** · branch removed by creator (return chip only) · discussion empty · offline (cached item plays, chat queued).

**Not drawn:** **next item preparing** inside the branch epbar; **branch removed**; **empty branch discussion**; a **Scroll item inside a what-if branch**; **ready-notice when the branch's first Reel lands** (X02 says "We'll post here").

**Controls → semantics**

| Control | Contract |
|---|---|
| Open branch | `GET /v1/explorations/:id` (bounded ancestry/children + **own position**) (`branch.open{branchId}`); first item → `navigate`/`activate`. |
| Return chip / Back | Pop to the original sequence at the caller's own anchor (Part 2 paused at 0:18) (`thread.return`). |
| Branch item chip | Select the branch item (own position per branch). |
| Talk about this branch / In this branch vs Whole thread | Message scope filter: `POST /v1/content-threads/:id/messages {scope: branch|thread, branchId}` (`message.send{scope}`); read filtered windows. **Gap:** §7's thread message route has no `scope`/`branchId` field; add it. |
| Try another assumption → Continue | `POST /v1/explorations/:id/branches` (new assumption from this node; explicit request). |
| Not now | Dismiss. |
| Resume at branch 1 · 0:14 | Reopen the branch at the caller's own position. |
| Like / Save / Share (moment) | As usual; obs `reel.visible_interval{branchId}`. "Branch content feeds only the viewer's own universe." |

**Data:** branch title, kind + epistemic tags, branch item ordinals ("Branch · 1 of 2", never "Part 5"), the user's return anchor (Part N · m:ss), own per-branch position, "Opened by you" (own history), message scope.

**Components:** `retchip` (yellow return chip with ← and destination), `ep.br` / `ep.br.cur` branch item chips (cobalt dashed / filled), persistent hypothetical banner, "Talk about this branch" bar, scope `seg`, `sysl`, inline "Try another assumption" box, `go` resume link.

**Conflicts / flags**

- **"Branch · 1 of 2"** is fine (never numbered as a series part). Compliant with §17.
- **The label uses "What if · Speculative", not "Hypothetical".** The storyboard (J2-08) says "What if · Hypothetical" and "Part 2 of 3 · Hypothetical". On the consumer artboards "Hypothetical" appears **only** in Components/Tokens/Main/storyboard. **Resolution:** see the X02 taxonomy (always Hypothetical for what-if items, plus Speculative when applicable).
- **"Ravi: Back on Part 3 now."** is user-authored, which is fine. The system must not broadcast this.

---

## X04 · Branch map (optional, v2)

- **Board:** 1330×1480. Three phone frames. Desktop: the same outline in a D03 side panel.
- **Purpose:** "Only offered once a thread has grown several branches. The first what-if never needs it: cards in the chat are enough." §18 "Branch history": root, ancestry, changed assumptions and sibling paths; lazy-loaded; no implication every suggested node has generated content.

**Frames / states drawn**

1. **Map appears** ("Only after the thread branches out"). The thread header gains a **Map** button (`a.btn.sm`, branch glyph, yellow focus ring). Thread items: the what-if card (What if + Speculative), the perspective card, Meera "Started one from Part 3 too.", a what-if card "What if time stopped completely at the edge? / From Part 3 · preparing".
2. **Outline map** ("Readable at phone width; your path marked"). **Close map** (×), `h2` "Map of this thread". `ul.tree[aria-label="Thread map"]`: `mono` "ORIGINAL · BLACK HOLES"; `button.node` "1 What a black hole actually is"; `node.on` "2 The edge you can't come back from" + `span.you` "**YOU**" (yellow ring); children `ul.tree.kid.on`: `node.wi.on` (cobalt dashed, branch glyph) "What if a black hole were a portal? / Speculative · 2 items"; `node.pv` "⊙ Information puzzle · PERSPECTIVE"; `node.sug` (grey dashed) "What if the Sun became a black hole? / SUGGESTION · NOT MADE"; "3 Why time slows near one" with child `node.wi` "What if time stopped completely at the edge? / Preparing"; "4 Do black holes last forever?".
3. **Large map** ("Filter, search, load groups on demand"). `label` "Search branches" + search field; seg `aria-label="Show"`: **Mine | Everyone** (pressed) **| Suggestions**. Tree: "2 … YOU" → "What if a black hole were a portal?" (on), "**More from Part 2 · Show**" (collapsed group, dashed); "3 Why time slows near one" → **two hatched skeleton rows** (group loading); "4 Do black holes last forever?" → "More from Part 4 · Show".

**States in the notes:** small map · large map with collapsed groups · group loading (skeleton) · suggestion not made · preparing · removed branch (shown as "Removed") · empty search · offline (cached outline, jumps disabled for uncached nodes).

**Not drawn:** **removed branch** node, **empty search**, **offline jumps disabled**, the **"Suggestions" filter** result.

**Controls → semantics**

| Control | Contract |
|---|---|
| Map | Opens the overlay (obs `thread.map_opened`); not a history entry. |
| Node | Jump: `branch.open{branchId}` → opens at the caller's own position there (pushes onto Back history). |
| Mine / Everyone / Suggestions | Filter (obs `thread.map_filter{kind}`); "Mine" = branches the caller started/opened. |
| Show (collapsed group) | Lazy page: `GET /v1/explorations/:id` children by parent node, paged ("Lazy: GET groups by parent node, paged"). |
| Search branches | Search within the permitted graph (client or server). |

**Data per node:** ordinal (original parts only), title, kind (what-if / perspective / suggestion), status (ready / preparing / not made / removed), epistemic tag, content count ("2 items"), **"YOU" (own position only)**.

**Components:** `tree` / `kid` nested lists (`role=tree` on web), `node` variants (`.on`, `.wi`, `.pv`, `.sug`), `you` marker, collapsed group row with Show, skeleton rows, search + filter seg.

**Conflicts / flags:** compliant ("'You' marks only your own position, never other people's viewing"; suggestions marked "not made"). **Mine/Everyone filters** imply per-node attribution (who started which branch), which is shared contribution history. That is allowed.

---

## R01 · Cosmic room preview

- **Board:** 1330×1480. Three frames (one `phone.sp` map, two paper/dark-header previews). Desktop: the D02 station card.
- **Purpose:** "A room is a station in your own geography. **One room, one identity — but it sits wherever it fits on each person's map.** No activity counts."

**Frames / states drawn**

1. **Station on Asha's map** ("Between ML and Backend"). Back pill **‹ Universe**, **List view** pill. The station glyph between the Machine learning and Backend systems systems. A card `div[role=dialog][aria-label="Model serving room"]`: `mono` "A ROOM · STATION", **Close** (×), `h2` "Model serving room", "A room about running models for real people.", access `tag` "**Open to friends of members**", **Enter room** (pri), **Close**.
2. **Room preview** ("Who's who, before joining"). A dark header band `div.rhead`: **‹ Map**, `mono` "COSMIC ROOM", `h2` "Model serving room", station glyph. Body: "Running models for real people: batching, scaling, latency and cost. Bring questions, Reels and half-formed ideas." `mono` "WHO'S HERE TO HELP": `div.prow` rows: `tag` (green outline, shield) "**Moderator**" "Keeps the discussion on track"; `tag.ai` "**AI · Explainer**" "Answers when asked"; `tag.ai` "**AI · Skeptic**" "Pushes back on claims". "AI inhabitants are labelled and never pretend to be people." A **Pinned question** box: "When does batching stop helping?". **Room guidelines** (heading; body "Be kind, cite what you're unsure about, and keep personal details out."). **Join room** (pri) + "Joining doesn't change your universe."
3. **Access required · paused** ("Two honest variants"). Header with ‹ Map. Card 1: `tag` "🔒 Invite-only", "**This room is invite-only — ask a member** / If a friend is in it, they can send you an invite from the room." **Message a friend** (→ C01). Card 2 (dashed): `tag` "⏸ Paused", "**Paused by the moderator** / You can read earlier messages. New messages are off for now." **Read the room** (→ R02). Footnote "The station stays on your map either way."

**States in the notes:** card · preview · open · invite-only · paused · removed from room ("You're no longer a member") · room closed · offline (cached preview, Join disabled with reason). "No member, active or online counts."

**Not drawn:** **removed from room**, **room closed**, **offline preview**, the **joined** confirmation, **request-invite sent**.

**Controls → semantics**

| Control | Contract |
|---|---|
| Station tap | Card overlay (obs `universe.select{stationId}`). |
| Enter room / Join room | `GET /v1/rooms/:id` (preview; obs `room.preview_opened`) → room join command (`room.join{roomId}`; §7 "room commands": propose `POST /v1/rooms/:id/join`, idempotent). |
| Message a friend | → Talk; `room.request_invite{roomId}` (gap: `POST /v1/rooms/:id/invite-requests`). |
| Read the room | Read-only R02 (paused). |
| ‹ Map / ‹ Universe / Close | Back to the map with the same camera and the station card still open. |
| List view | U02-style list (rooms listed under their systems). |

**Data:** room name, one-line + long description, access policy tag (Open to friends of members / Invite-only), state tag (Paused), roles (Moderator, labelled AI inhabitants with role names and one-line behaviour), pinned question, guidelines. **No member/online counts.**

**Components:** station card (dialog), `rhead` dark header band, role rows (`prow` + `tag` moderator / `tag.ai`), pinned box, guidelines, access/paused state cards (solid / dashed).

**Conflicts / flags:** compliant: AI identifiable, no counts, and "Joining doesn't change your universe" (§17: joining/chatting alone supplies no evidence).

---

## R02 · Room threads & explorations (v2) — covers brief R04 "Room content thread"

- **Board:** 1752×1480. Four phone frames. Desktop: D04 (room info left, thread centre, optional activity right).
- **Purpose:** "Same model as private threads, different membership. **Each exploration belongs to one room thread**, so groups can follow different what-ifs without changing the whole room's topic. **AI may suggest; people decide what gets made.**"

**Frames / states drawn**

1. **Room · threads** ("Each thread is a content thread"). Dark band `div.rband`: Back, station glyph, `b` "Model serving room", "Running models for real people · Moderated · AI inhabitants are labelled". `mono` "THREADS" + **+ Share into room** (`btn.sm.pri`). Room-thread rows `a.rt`:
   - "🛡 **Pinned by Moderator**" · cobalt thumb · "**What one answer costs to serve**" · "Reel · started by Ravi" · cobalt "⚑ Exploring: requests increased tenfold"
   - "**Offline inference**" · "Scroll · started by Meera" · "⚑ Exploring: what if it must run on a phone?"
   - "**Where should the model run?**" · "Reel · started by Asha" · "Discussion only"
2. **Inside a room thread** ("Moment → AI suggestion → human choice"). Band: Back to room, "What one answer costs to serve / in Model serving room", item chips `ep.cur` "**Reel · current**" and `ep.up` "**Scroll version**" (the format variant appears as a navigator item). Messages: Meera (avatar) + snippet `div.snip` "0:12–0:24 · Play / 'The bill is the hardware time.'"; Ravi "So more traffic means a bigger bill, linearly?"; **AI message**: `tag.ai` "AI · SKEPTIC" + `div.bub.ai` (**dotted outline, square corner**) "Not necessarily. Suggestion: what if requests arrive in bursts instead?" + **Explore this** (`btn.sm`, cobalt dashed) / **Dismiss** (ghost); a what-if card `article.brc` "WHAT IF / What if requests increased tenfold? / Same model and hardware. · Started by Ravi / Explore this →". Composer "Message this thread…".
3. **Moderator tools** ("Organise, pin, report still there"). Band "You're moderating this room". A what-if card "What if requests increased tenfold? / Branches: Batching · More instances" (yellow focus). Sheet `msheet[aria-label="Moderator actions for this exploration"]`: "This exploration": **Pin to the room** (shield), **Move into its own thread**, **Mark as helpful**, **Close to new branches**, **Report** (rust). "Pinning shows it at the top of the room. It doesn't change anyone's universe or position."
4. **Retry · removed · quiet** ("AI never fills the silence"). Thread "Offline inference": Meera's message; a dashed placeholder "🛡 **Message removed by the moderator**"; my failed bubble (rust) "Does quantising count as a smaller model?" + **↻ Not sent · Retry**; a quiet-state card "**It's quiet here right now** / AI inhabitants speak when someone invites them. They won't fill the room on their own." + **Ask [AI · EXPLAINER]** button.

**States in the notes:** room ready · thread empty · AI suggestion pending human choice · dismissed · exploration preparing/ready · send failed → retry same bubble · removed by moderator · reported · access lost · quiet room (honest, no filler).

**Not drawn:** **thread empty**, **AI suggestion dismissed**, **access lost** inside a room, **reported** confirmation, **Share into room** picker (choosing content to start a room thread), a **second simultaneous discussion unaffected** (implied by frame 1's separate "Exploring:" lines; J3/J4 do not show it either), the **AI answer** after "Ask AI · Explainer" (pending/answered).

**Controls → semantics**

| Control | Contract |
|---|---|
| Room thread list | `GET /v1/rooms/:id` (canonical room feed: threads, pins). |
| Share into room | `room.thread.create{roomId, assetRevision}` → `POST /v1/content-threads` `{parent: roomId, root}` (§7: "under a conversation or room"); private-source access is re-checked (§17). |
| Thread row | `/rooms/[roomId]/threads/[threadId]` → `GET /v1/content-threads/:id`. |
| Reel · current / Scroll version chips | Format variant navigation inside a thread (navigate with format variant). |
| AI suggestion: Explore this | A human explicitly selects the AI-suggested branch → `POST /v1/explorations` / `…/branches` `{source: ai_suggestion}`. "AI suggestions are messages, never commands." |
| Dismiss | Hides the suggestion (gap: dismiss route, or a client-local hide). |
| What-if card Explore this | X03. |
| Moderator sheet actions | `room.pin{threadId|branchId}`, move to its own thread, mark helpful, close to new branches, `moderation.remove`, `report.abuse` (§7 "room commands … moderation"). **None commissions production.** |
| Not sent · Retry | Same-requestId retry. |
| Ask [AI · Explainer] | Explicitly invites an AI inhabitant to answer (a bounded harness call). **Gap:** no route. Propose `POST /v1/rooms/:id/threads/:threadId/ai-invocations {inhabitant, messageId}` (rate-limited, labelled output). |

**Data:** room name/description/badges (Moderated, AI labelled), thread rows (title, format, starter, pinned flag, current exploration one-liner or "Discussion only"), message author kind (**human / moderator / AI inhabitant with role**), snippet cards, branch cards (started by, branches list), moderation placeholders.

**Components:** `rband` room band, `rt` room-thread rows (pinned badge, exploring line), `ep` item chips including a format-variant chip, `bub.ai` AI bubble (dotted outline + square corner + `tag.ai`) with Explore this/Dismiss, `brc` branch card, moderator action sheet, removed-message placeholder (dashed + shield), failed bubble + retry, quiet-state card with an AI invite button.

**Conflicts / flags**

- **AI suggestion containing "Suggestion: what if…" text:** it must be clearly an AI message (done) and must not auto-commission (done: "Explore this" is human).
- **"Started by Ravi" / "Pinned by Moderator"** are contribution/moderation history and allowed.
- **"Scroll version" as a navigator item** mixes format variants into the episode navigator, while §17 says the format variant is a Reel/Scroll switch preserving identity. **Resolution:** use the standard Reel/Scroll seg in the thread player rather than a navigator chip, or label the chip clearly as a format toggle.
- **Room access does not grant access to private source assets** (§17). Share into room must block private sources (no drawn state; add one).

---

## R03 · Optional room activity

- **Board:** 1330×1480. Three phone frames. Desktop: D04 side panel.
- **Purpose:** "Polls and quizzes exist only inside a room you chose to enter. **Never in the feed, never required, never scored, never part of how worlds form.**"

**Frames / states drawn**

1. **Poll** ("Started by the moderator"). Dark bar `div.rbar` (Back to discussion, "Model serving room"). Tags "Optional" and "🛡 Moderator poll" (green). `h2` "At 10× requests, what would you try first?" `legend` "PICK ONE"; `button.opt[role=radio]` rows with `span.dot`: **Batching** (checked, cobalt offset shadow), **More instances**, **Shorter answers**. "Your vote is visible to the room. You can change it until the poll closes." **Skip** (ghost), **Vote** (pri).
2. **Optional room quiz** ("One question at a time"). Bar: **Leave quiz** (×) "Room quiz". Banner "ⓘ **Optional** · nothing here shapes your universe. Leave whenever you like." `mono` "QUESTION 1 OF 3", `h2` "Requests arrive one every few seconds. Does a large batch size help?", radiogroup "Answers": "Yes — bigger is always faster" / "**Not much — batches rarely fill**" (checked) / "Only on new hardware". **Skip question**, **Next**.
3. **Answers, not a score** ("Explanations + discuss"). Bar "Room quiz · answers". "Here's how each one works out. Nothing is kept as a result." `div.ans` cards: "1 · SLOW TRICKLE OF REQUESTS / **Batches rarely fill, so a big batch size mostly adds waiting.** / A maximum wait sends whatever has arrived."; "2 · TEN TIMES THE TRAFFIC / …"; "3 · A STRICT RESPONSE TIME / …". **Discuss this** (pri), **Done**.

**States in the notes:** open · voted (change allowed) · closed · quiz in progress · answers view · activity removed by moderator · offline (vote queued, shown as "Not sent yet"). "No score, grade, rank, streak or leaderboard."

**Not drawn:** **voted** (with the change option), **poll closed / results**, **removed by moderator**, **offline "Not sent yet"**.

**Controls → semantics:** Vote → `room.poll.vote{activityId, optionId}`; quiz answer → `room.quiz.answer{activityId, questionId, optionId}`. Both are **room commands** (§7 "room commands"; propose `POST /v1/rooms/:id/activities/:activityId/votes|answers`). Skip / Leave → no command (obs `room.activity_skipped`). Discuss this → back to R02 with a reference. "None of these are encounter evidence or inputs to formation." Route `/rooms/[id]/activity/[activityId]`.

**Components:** `rbar`, `tag` Optional + moderator tag, `opt` radio cards with `dot` (the selection uses fill + dot + offset shadow), optional banner, question counter, `ans` answer-explanation cards, equal-weight exit buttons.

**Conflicts / flags**

- **Poll results are not drawn.** Showing vote **counts** for a room poll is room activity, not consumption comparison. That is acceptable, but keep it to percentages/bars per option and never per-person rankings.
- **"Your vote is visible to the room"**: make sure F02 visibility does not need to cover this (it is room-scoped, which is fine).
- Compliant with "no routine quizzes in the feed".

---

## F01–F02 · Friends & sharing settings

- **Board:** 1752×1480. Four phone frames (F01 ×3, F02 ×1). Desktop: D05 pattern.
- **Purpose:** "Friends come from **handles and invite links you choose — never an address-book upload**. Visibility is **per system**, and revocation is spelled out honestly."

**Frames / states drawn**

1. **F01 · Friends** ("Friend, pending invite, blocked collapsed"). `div.top`: **Back to account** (‹), `h2` "Friends". **+ Add a friend** (pri). `mono` "FRIENDS": `div.lrow` Ravi "● Online · can visit what you share" + **Options for Ravi** (⋯). `mono` "WAITING": Meera (dashed avatar) "@meera.s · invite sent" + `tag` "🕐 Pending". A collapsed disclosure **Blocked** "People who can't message or find you" (`aria-expanded=false`). A link row **Who can visit your universe** "Friends I choose · Ravi ›".
2. **F01 · Add a friend** ("Handle or invite link; no contacts upload"). **Close** (×), `h2` "Add a friend". `label` "Their handle" + input "@ravi.m"; result row Ravi "@ravi.m" + **Send invite** (`btn.pri.sm`). "OR". A panel "**Share your invite link** / Anyone with this link can ask to be your friend. You still accept each request." **Copy link**, **More apps…**. A banner "🔒 We never upload your contacts. People find you only by your handle or a link you share."
3. **F01 · Requests & blocks** ("Incoming, blocked, revoked link"). `mono` "ASKING TO BE YOUR FRIEND": a Meera card "@meera.s · used your invite link" + **Accept** (pri) / **Decline**. `mono` "BLOCKED": "@kiran.dev / Can't message, invite or visit you" + **Unblock**. `mono` "YOUR INVITE LINK": banner "× **This invite link was turned off** / People who open it now see 'This link no longer works.' Requests already accepted are unchanged." **Make a new link**.
4. **F02 · Visibility** ("Who can visit; per-system sharing; activity status"). `h2` "Who can visit your universe". `legend` "VISITORS": `label.radio` **Nobody** / **Friends I choose** "Ravi" (checked, cobalt) / **All friends**. `mono` "WHAT THEY CAN SEE": `lrow` + `button.sw[role=switch]` per system: **Machine learning** "Shared" (on), **Backend systems** "Shared" (on), **Past** "Private · not shown to visitors" (off), **Rooms you join** "Can appear on your map" (on). `role=radiogroup[aria-label="Activity status"]` seg: **● Online | Recently active** (selected) **| Don't show**. "Never shows what you're watching." **👁 Preview what Ravi sees** (→ U06).

**States in the notes:** empty (no friends: invite card) · pending sent · incoming request · accepted · declined (silent to sender) · blocked · link revoked · visibility saving / saved / failed-retry. Hidden systems are simply absent for visitors. Activity status: Online · Recently active only · Don't show.

**Not drawn:** **empty friends** list; **visibility saving/saved/failed-retry**; the **⋯ friend options** menu (remove friend, block, stop sharing); the **handle-not-found** result; the **Blocked expanded** list on F01-1 (drawn on F01-3).

**Controls → semantics**

| Control | Contract |
|---|---|
| Send invite | `friend.invite{handle}`. **§7 has no friends routes: gap.** Propose `POST /v1/friend-requests {handle | inviteToken}`. |
| Copy link / More apps… | Create/get the personal invite link (`POST /v1/invite-links`); obs `invite_link.copied`. |
| Accept / Decline | `POST /v1/friend-requests/:id/accept|decline` (decline is silent to the sender). |
| Block / Unblock | `POST/DELETE /v1/blocks/:handle`. |
| Make a new link / turn off | `invite_link.revoke` + create a new one. |
| Visitors radio | `visibility.set{scope}`: a privacy endpoint (§7 "revoke sharing" family). |
| Per-system switch | `visibility.set{systemId, shared}`; applies to every **future** read immediately; the visitor scene is server-filtered. |
| Activity status seg | `presence.set{online|recent|hidden}`. |
| Preview what Ravi sees | U06 rendered with Ravi's permission filter (a server-rendered visitor scene as that friend). |
| Who can visit your universe › | → F02 (`/account/visibility`). |

**Data:** friend rows (name, handle, avatar, presence word, visit permission summary), pending invites, incoming requests (with origin "used your invite link"), blocked handles, invite link state, visitor policy, per-system share flags (by system, plus the "Rooms you join" flag), activity status.

**Components:** `top` header, `lrow` list rows, `av` avatars (dashed = pending), `tag` Pending, disclosure row, `label.radio` radio cards, `sw` switch rows, presence `seg` radiogroup, banners (privacy promise, revoked link), preview button.

**Conflicts / flags**

- Compliant: no address-book upload, presence never carries content, honest revocation copy ("screenshots … can't be clawed back").
- **Per-system sharing shows "Past"** (a family/sky-region name) next to systems. Clarify whether visibility is per **system** or per **family**. U08 calls "Past" a family heading. **Resolution:** per system (the blueprint scene unit), grouped by family in the UI.
- **The F01 entry point is via Account (P01) and the share sheet.** It is not a tab. Fine.

---

## P01 · Account & settings

- **Board:** 1330×1480. Three phone frames. Desktop: D05 pattern.
- **Purpose:** "Reached from your avatar. Sessions, comfort settings and notifications — **no streaks, no 'you missed' nudges**." Entry point: the avatar on the **Keep** (S01) and **Universe** headers (the notes); a notification's "Manage".

**Frames / states drawn**

1. **Account** ("Identity, sessions, settings index"). **Back to Keep** (‹), `h2` "You". An identity card (cobalt offset shadow): avatar "A", **Asha**, "@asha.k · asha@example.com", **Edit**. `mono.sec` "SESSIONS": "This phone · Signed in now" + `tag` "Current"; "Browser on a laptop · Last used 2 days ago" + **Sign out**. `mono.sec` "SETTINGS" link rows: **Friends & visibility** "Who can visit your universe" (→ F01); **Activity status** "Shown as 'Recently active' · never what you watch"; **Privacy & history** "Recording, export, clear exploration, delete" (→ P02); **Notifications**; **Accessibility & playback**. **Sign out** (ghost). NavBar (Keep active).
2. **Accessibility & playback** ("Mirrors OS settings by default"). `sw` rows: **Reduce motion** "Following your device · formation shows the final state" (on); **Text size** stepper `ibtn` A− / live preview "Attention, slowly" / A+ + "Uses your device size; up to 200% before layouts stack."; **Captions on by default** (on); **Autoplay with sound** "Off: Reels start muted after a detour" (off); **Haptics** (on); **Use list view for the universe** "An outline of systems, planets and regions" (off); **High-contrast labels in space** "Solid cream label plates" (off).
3. **Notifications** ("Only things you asked for or people said"). `sw` rows: **Ready requests** "A Scroll or Reel you asked for is ready" (on); **Messages** "From people in your conversations" (on); **Exploration activity** "A branch you chose is ready, or someone joins" (on); **Room mentions** "Only when someone replies to you" (off). `mono.sec` "QUIET HOURS": "22:00 – 08:00 · Held until morning, delivered once" (on). Banner "✓ We never send streak or 'you missed' reminders."

**States in the notes:** loading (row skeletons) · saving (switch disabled, spinner glyph) · saved · failed (the switch reverts + banner "Couldn't save · Retry") · offline (switches read-only, explained). Signing out a session asks once.

**Not drawn:** **loading**, **saving**, **failed revert**, **offline read-only**, **Edit profile** form (name/handle), the **sign-out-session confirm**, **notification permission denied** (OS).

**Controls → semantics**

| Control | Contract |
|---|---|
| Setting switches / text size | `settings.set{key, value}` (sync per account). **Gap:** §7 lists no settings route; propose `PATCH /v1/me/settings`. Reduce motion and text size mirror the OS until changed. |
| Sessions → Sign out | `session.revoke{sessionId}` (gap: `DELETE /v1/me/sessions/:id`). |
| Sign out (here) | `auth.sign_out` → AccountScope teardown: stop subscriptions, fence callbacks, purge scoped storage (§18 client state). |
| Notification switches / quiet hours | `notifications.set{channel}`, `quiet_hours.set` (gap: `PATCH /v1/me/notifications`). Native permission prompt only after a switch is turned on. |
| Edit | Profile edit (gap). |
| Row links | → `/friends`, `/account/visibility`, `/account/privacy`, `/account/notifications`, `/account/accessibility`. |

**Data:** display name, handle, email, sessions (device label, current flag, last used), settings values, notification channel switches, quiet hours.

**Components:** identity card, `lrow` rows (`who` label + sub-label), `tag` Current, `sw` switch rows, text-size stepper with live preview, `mono.sec` section headings, banner.

**Conflicts / flags:** compliant. **The account entry is only via avatars on Keep/Universe headers.** Explore and Talk have no visible account entry, which is acceptable under §18 ("consistently reachable"), but check that it really is reachable from every tab root, or add it to the ⋯ menu.

---

## P02 · Privacy & history

- **Board:** 2174×1480. Five phone frames. Desktop: D05.
- **Purpose:** "Every control says exactly what it changes. **One clearing operation — Clear exploration — and no time-range removal.** Pausing, export, clearing and deletion produce **receipts that stay pending until the work is really done** — and say so when it fails." This matches blueprint §19 (Pause personal recording; Clear exploration = Reset; Export; Delete; epoch).

**Frames / states drawn**

1. **Hub** ("Each row names its consequence"). **Back to account**, `h2` "Privacy & history". `sw` row **Shape my universe from what I watch** "On: Reels and Scrolls you actually watch or read can grow your worlds." (on). Link rows: **History & export** "Download a copy of your history, Keep and messages."; **Clear exploration** "Removes your history and universe. Keep and conversations stay."; **Sharing & visibility** "Who can visit your universe and which systems they see." (→ F02); **Delete account** (rust) "Removes your account, universe, Keep and messages you sent." Footer copy: "Your universe grows from the Reels and Scrolls you actually watch or read. Messages are stored for your conversations. They aren't treated as evidence of what you explored. Recommendations and things we prepare for you never count either."
2. **Recording paused** ("No silent back-fill later"). A dark banner "⏸ **Recording paused** / While paused, what you watch won't shape your universe. Save, Share and Talk still work. Nothing is filled in later." **Resume recording** (`btn.sp.sm`). The switch row (off) "Off since today, 21:40". "WHAT STAYS THE SAME": "Your existing systems and planets stay exactly as they are." / "Things you Save are kept, with your place in them." / "Requests you make still get prepared." "WHAT CHANGES": "No new worlds or regions form from this time." / "The feed only follows what you ask for right now."
3. **Export receipts** ("Pending · ready · failed"). **Request a new export** (pri). "YOUR EXPORTS": `div.rcpt` receipts (`div.h` status + `mono` date): **◌ Preparing** "Today 21:52" "History, Keep and messages. We'll notify you when it's ready." (striped); **✓ Ready** "3 Oct" "The download link expires in [N days]." + **Download**; **↻ Failed** "28 Sep" "We couldn't finish this export. Nothing was sent anywhere." + **Retry** (rust).
4. **Clear exploration · confirm** ("One operation; consequences, then a deliberate step"). "WHAT'S REMOVED" (rust): "Your watch and read history." / "Everything we worked out from it — your current interests and plans." / "Your universe: every system, planet and region." "WHAT STAYS" (teal): "Keep items, with your place in them." / "Your conversations, threads, rooms and messages." / "Your friends and sharing settings." "Friends who visit will see an empty universe. A new one grows from what you explore next." A dashed-rust box: checkbox "I understand this can't be undone." + `btn.danger` **🗑 Clear exploration** (disabled until checked).
5. **Receipts · clear & delete** ("Live removal completes; backup expiry is a separate line"). `h2` "Receipts". "CLEAR EXPLORATION": **◌ Clearing** "Today 22:04" "Removing your history and universe from the app and our live systems." → "THEN" **✓ Cleared from KnowScroll** "Your universe and history are gone from the app and our live systems. Keep and conversations untouched." + "🕐 **Backups · pending.** Backup copies expire on their own within [N days]; they aren't used to rebuild anything." "DELETE ACCOUNT": **◌ Deletion in progress** "You're signed out everywhere. Removing your account from our live systems. Backup copies then expire within [N days]."; **ⓘ We couldn't finish removing** "Nothing has been reported as cleared yet. Retrying continues the same request." + **Retry** (danger).

**States in the notes:** recording on/paused · export pending/ready/**expired**/failed · clear confirm → clearing → cleared from live systems (completes) + backup expiry within [N days] (a separate pending line that never blocks "cleared") / failed · delete pending/failed. **Offline: controls read-only with an explanation; nothing queues silently.**

**Not drawn:** **export expired**; the **delete account confirm** screen (the destructive flow before "Deletion in progress"); **offline read-only**; **clear exploration failed** (only delete failed is drawn); **the post-clear empty universe** (U01 empty covers it).

**Controls → semantics**

| Control | Contract |
|---|---|
| Shape my universe… switch / Resume recording | `privacy.recording.set{on|off}`: §7 "Privacy/export endpoints: Pause recording" (idempotent receipt). |
| Request a new export / Download / Retry | `privacy.export.request` → receipt `pending → ready → expired | failed`; `receipt.retry{receiptId}` continues the same request. |
| Clear exploration (after checkbox) | `privacy.clear_exploration` (= §19 "Clear exploration history" = "Reset personal universe"). It advances the privacy epoch; the client purges caches, recorder buffers and scoped storage (§18 AccountScope keyed by `(accountId, privacyEpoch)`). |
| Delete account | `account.delete` (receipt pending/failed; signs out everywhere). |
| Receipts list | Read receipts (gap: `GET /v1/privacy/receipts`). |

**Data:** recording state + since-timestamp, export receipts (status, timestamp, contents description, expiry), clear/delete receipts (live-systems step, separate backup-expiry line with "[N days]" placeholder), explicit consequence lists.

**Components:** `sw` row, link rows with consequence sub-labels, dark paused banner, what-stays/what-changes lists, `rcpt` receipt cards (`h` status line with glyph; striped pending, teal ready, rust failed), acknowledgement checkbox, `btn.danger` (disabled until acknowledged).

**Conflicts / flags**

- **Strongly aligned with §19.** It adds a "no time-range clearing" decision (§19 recommends one clear operation; compliant).
- **"[N days]"** is a placeholder. The real retention values must come from the ops policy before shipping.
- **"Delete account … messages you sent"**: §19 recommends removing private message bodies while leaving an unavailable-message marker for others. The copy is close. Make sure the C02 rendering of a deleted sender's messages exists (not drawn).

---

## P03 · Feedback & report

- **Board:** 1752×1480. Four phone frames. Desktop: popover / dialog.
- **Purpose:** "Preferences take one tap and need no reason. Reports are scoped, anchored to the moment, and acknowledged with a receipt." Overlay only: no route of its own.

**Frames / states drawn**

1. **⋯ / long-press menu** ("On a Reel or Scroll"). `div.scrim` + `msheet`: `mono` "REEL · MACHINE LEARNING", `b` "Attention, explained with a crowded sentence". `button.mi` two-line menu items with icons: **Not interested** "Fewer like this one"; **Hide this subject for a while** "Machine learning · you can undo in Keep"; **Report a content error** "Something here seems wrong"; **Report abuse**; **Copy link**. **Cancel**.
2. **Not interested · acknowledged** ("No reason asked; Undo inline"). A dark banner "✓ Got it — fewer like this." + **Undo** (`btn.sp.sm`). The next subject (Football, "Why the high press works") is already loaded underneath ("Next subject loaded after the hidden Reel").
3. **Content error report** ("Anchored at 0:31; note optional"). **Close** (×), `h2` "Report an error", a content card (thumb, title, `mono` "AT 0:31 · CHANGE"). "What seems wrong?" `button.chip[aria-pressed]`: **Something's wrong** (pressed) / **Out of date** / **Misleading** / **Other**. `label` "Add a note (optional)" + textarea "'it' could also mean the street here?". **Send report** (pri). Annotation banner: "After sending: 'Thanks — if we correct it you'll see a Corrected tag.'"
4. **Abuse report · received** ("Room message; block offered"). The room conversation: Meera's message; @kiran.dev's message replaced by a dashed placeholder "**Hidden for you · reported**". Sheet: "✓ **Report received** / The room's moderator and our safety team will review it. The message is hidden for you now. You don't need to do anything else." A receipt box `mono` "RECEIPT" "Reason: harassment · message in Model serving room · today 22:11". **⊘ Also block @kiran.dev** (rust outline), **Done**.

**States in the notes:** menu · acknowledged + Undo (timed) · error form → sending → received / failed-retry (same request ID) · abuse form → received receipt · offline: report queued with visible "Will send when online".

**Not drawn:** the **abuse report form** (the category picker; "Reasons are optional everywhere except picking an abuse category"); **error report sending/received/failed**; **offline queued**; the **"Hide this subject" acknowledgement**; a **Scroll** variant of the content-error anchor (block ID); **report from a friend's universe (U06)**.

**Controls → semantics**

| Control | Contract |
|---|---|
| Not interested | `POST /v1/actions` `{kind: not_interested, scope: item}` → advances to the next subject (`navigate`). Undo → `feedback.undo` (the inverse action, timed). |
| Hide this subject for a while | `POST /v1/actions` `{kind: hide_subject, subjectId, duration}`. It affects the feed only; existing worlds stay. "You can undo in Keep" means a Keep management view for hidden subjects is needed (**not drawn anywhere**). |
| Report a content error → Send report | `report.content_error{revisionId, anchor, category, note}` (§18 "Content feedback"). **Gap:** no §7 route; propose `POST /v1/reports {kind: content_error, ...}`, idempotent. |
| Report abuse | `report.abuse{target, category}` → `POST /v1/reports {kind: abuse}`; the target is hidden for the reporter. |
| Also block | `friend.block` (`POST /v1/blocks`). |
| Copy link | Share link (H01 copy). |

**Components:** `scrim`, `msheet`, `mi` menu items (icon + title + sub-label), undo banner, report form (content chip with anchor + change link, `chip` category toggles, textarea), hidden-message placeholder, receipt box, rust block button.

**Conflicts / flags**

- **The ⋯ menu has no "Next subject"**, yet A03/E01 rely on it ("Next subject in ⋯ menu") as the accessible equivalent of swipe-up. **Resolution:** add "Next subject" (and "Continue: Part N") to the ⋯ menu.
- **"Undo in Keep" for hidden subjects** has no Keep view. Add a Keep → "Hidden" section (C03 also mentions "Hidden" for ignored invitations).
- **Error-report categories are user feedback** and must not surface any "sources" panel. Compliant.

---

## Prototype.html and Prototype-storyboard.html

- **Prototype.html** (1440×1000) is the **static first step of the clickable prototype**: a left column (title "Clickable journeys", "Press Play. Click the control ringed in yellow, or use Next. All people and content are authored examples.", a journey selector `nav[aria-label=Journeys] > button.jbtn[aria-pressed]` ×5, step list `ol[aria-label=Steps] > button.stepbtn[aria-current=step]`), a centre phone (`div.ph`) with the **hotspot** control ringed in yellow (`.hot`), and a right column (`mono` "<journey> · STEP n OF N", `h2` step title, description, an "EMITTED AT THIS STEP" box listing `CMD`/`OBS`/`Receipt` lines, a "RESTORE · PRIVACY · GESTURE" box, and **Previous step / Next step / Hotspot rings** toggle buttons). The clickable version needs the canvas runtime. The export is static.
- **Prototype-storyboard.html** stacks **all 40 steps** of the **five** journeys (the task brief says four; the export has five: J1 Asha's encounter path 8 steps, J2 Black holes content thread 9, J3 Spatial exploration 8, J4 Recovery & privacy 7, J5 Back step by step 8). Renders: one PNG per step at `design-reference/renders/storyboard/J<j>-S<nn>.png` (1440 wide).
- The prototype phones are simplified re-drawings of the artboards (class names `ph`, `top`, `cc` caption, `rail`, `edge.rel`, `ttl`, `prog`), so **copy sometimes differs from the artboards**. Differences are flagged below.

---

# STORYBOARD — the five clickable journeys (→ end-to-end journey tests)

Notation: **[screen (artboard)] → action (the hotspot control) → next**. "Emits" lists the design's command/observation names. The "Test assertions" bullets are what the e2e test must check (derived from the step's restore/privacy note plus the blueprint).

## Journey 1 · Asha's encounter path (8 steps)

| # | Screen (artboard) | Hotspot action | Emits (design) | Blueprint contract |
|---|---|---|---|---|
| 1 | ML Reel Part 1 of 3 playing at 0:31, dashed **Related** edge tab (E01/E05) | tap **Related → A spotlight with a budget** edge tab | OBS `reel.visible_interval{0–31s}`, `app.visibility` | `POST /v1/observations/batch` |
| 2 | Related Reel "A spotlight with a budget" (`tag` "Related · another angle", 0:12/0:44) with a return pill "Part 1 · 0:31" (E05-2) | tap the **Part 1 · 0:31** pill (back) | CMD `thread.continue{relation: related}`, OBS `reel.visible_interval` | `POST /v1/experience/navigate` (related) + `activate` |
| 3 | Part 1 Reel resumed at 0:31; seg shows **"Scroll · preparing"** + chip "We'll let you know when the Scroll is ready · Cancel"; toast "Resumed at 0:31" (E06-2) | (Scroll segment tapped) → wait | CMD `format.request{to: scroll, explanation: attention-mechanism}` | `POST /v1/content-requests` (format variant) |
| 4 | Part 1 playing 0:46; notice "**Your Scroll is ready** · 'Attention, slowly'" + **Open** (E06-3 / E07) | tap **Open** | Receipt `request.ready` (socket notice) | Socket.IO `scope_changed` → `GET /v1/content-requests/:id` |
| 5 | Scroll "Attention, slowly · 3 / Why squared?" with the **"Try a longer sentence"** slider block (1,024 words, "Work grows about 4× while the text grows 2×") (E02/E03/H03-3) | drag the slider, then tap **Back** | OBS `scroll.block_coverage`, `scroll.block_interaction{block: len-slider}` | observations batch |
| 6 | Part 1 Reel **"Paused where you left it · 0:31"** with a Play button (E01) | tap **Next subject** | none (client restoration) | client state |
| 7 | Astronomy Reel "Why does an orbit keep falling?" 0:04/0:41 (E01) | tap "**Later that week · open Universe**" | CMD `subject.next` | `POST /v1/experience/navigate` (vertical) |
| 8 | Universe: "Since you were last here · **A new place: Attention** · It sits in Machine learning, near where you've been exploring." (U01/U05) | Restart | Receipt `geography.delta_applied → scene revision 2`, OBS `universe.open` | `GET /v1/universe` (delta with transitionId) |

**Test assertions (J1):** a related move is not labelled as a Part; Part 1's playhead is preserved (0:31) across a related detour and a Scroll detour; returning from a detour is **paused, not autoplay**; a missing format sibling creates exactly one content request (idempotent), the Reel keeps playing, and there is no percentage; the ready notice never auto-switches; slider state persists by `(articleRevision, blockId)` and the slider drag never scrolls the article or emits navigation; only a fresh act changes subject; formation shows only after a server delta and copy names a place, not a skill.

## Journey 2 · Black holes: a content thread (9 steps)

| # | Screen (artboard) | Hotspot action | Emits | Blueprint contract |
|---|---|---|---|---|
| 1 | Share sheet over Part 2 "The edge you can't come back from" with four choices (H01-1) | tap **Explore with friends** | OBS `share.sheet_opened` | none (overlay) |
| 2 | Friend picker: thread name "Black holes", Ravi (Online) ✓, Meera (Recently active) ✓, Kabir (no status) (H01-3) | tap **Create thread · 2 friends** | (selection local until created) | — |
| 3 | Content thread: player Part 2 · 0:18, action strip **Like · Save · Moment · Full screen**, episode cards (Part 1 ✓, Part 2 Now, 3, 4), "You started this thread", Ravi "That last part surprised me.", What if… (C04-1) | tap **Moment** | CMD `thread.create{members:[ravi, meera], root: blackholes-part2}`, Receipt `thread.created` | `POST /v1/content-threads` (idempotent) |
| 4 | Share a moment sheet: Part 2 · 00:18 → range 00:18–00:31, "Drag the ends to adjust", message "Look at this moment:", To · Black holes thread (H03-1) | tap **Share moment** | CMD `snippet.share{asset: part2@1, start: 18, end: 31}` | `POST /v1/snippets` + thread message |
| 5 | Thread **collapsed**: chips 1 ✓ / 2 · now / 3 / 4, mini bar "Part 2 · Paused at 0:18 · Collapsing pauses", Meera "Joining late — starting at Part 1." (C04-2) | tap **What if…** | CMD `thread.player.collapse → pause`; OBS `reel.visible_interval` stops | client player state |
| 6 | What-if sheet (What if… / Another perspective), idea "Show what happens if the Sun were replaced by a black hole of the same mass.", summary "Changed · Sun → black hole, same mass / Kept · Earth's orbit · Edit"; suggestions list incl. a "Speculative scenario: What if a black hole were a portal?" (X01-1) | tap **Explore** | none ("summary computed locally; nothing sent until Explore") | (see the X01 conflict: needs a server draft) |
| 7 | Branch card in thread: "**What if · Hypothetical** / What if the Sun became a black hole of the same mass? / Changed… Kept… Asked by Asha, from Part 2. / **First Reel ready**", Ravi "Wait — would we just keep orbiting?" (X02) | tap **Explore this** | CMD `scenario.ask{text, assumptions, direct: true}`, Receipt `request.ready` | `POST /v1/explorations` + `/branches` |
| 8 | Branch view: return chip "**‹ Back to Black holes · Part 2 · 0:18**", banner "WHAT IF · HYPOTHETICAL · The Sun becomes a black hole · same mass", branch chips "1 · now" / "2 · Preparing", Reel "Same pull, no sunlight" 0:14/0:48 (X03-1) | tap the **return chip** | CMD `branch.open{node: sun-black-hole}`, OBS `reel.visible_interval (Asha)` | `GET /v1/explorations/:id` |
| 9 | Back in the thread at "Part 2 · paused at 0:18"; the branch card now "**Opened by you**"; Meera (Online) "Caught up on Part 1. Is the Sun one worth it?" (X03-4) | Restart | none (restoration only) | — |

**Test assertions (J2):** opening the sheet is not a share; thread creation is idempotent (a retry does not duplicate); markers are caller-only (Meera starts at her own Part 1, and Asha never sees "Meera is watching…"); collapsing pauses and stops visible-interval recording; the snippet references `{assetRevision, startMs, endMs}` with no new media; a complete what-if commissions directly with an editable summary; a speculative idea goes to the confirm step; the branch is never numbered as "Part 5"; Preparing items are not selectable; the return chip pops to Part 2 paused at 0:18 and the conversation scroll is restored; nobody else's player moves. **Plus:** the ordinary "Send to conversation" path without creating a thread (the brief's journey 2 requirement; H01-2 covers it, but there is no storyboard step). **Not in the storyboard:** "one joins later" (only Meera's message hints at it), "share a Scroll passage/block state" (H03 frames only), and "explore an alternative branch" (X03-3).

## Journey 3 · Spatial exploration (8 steps)

| # | Screen (artboard) | Hotspot action | Emits | Blueprint contract |
|---|---|---|---|---|
| 1 | Your universe (Lately on) (U01-3) | tap **Machine learning** system | OBS `universe.open` | `GET /v1/universe` |
| 2 | Machine learning · a system (U02-1) | tap **Inference & serving** planet | OBS `universe.select{system: ml}` | — |
| 3 | Inference & serving planet with regions Batching/Deployment/Latency/Cost (U03-1) | tap **Deployment** region | OBS `universe.select{planet: inference}` | — |
| 4 | Region card "A Reel · in Deployment / Where should the model run? / Close to people, or close to the hardware? The trade in under a minute." Open / Close / More in Deployment (U04-1) | tap **Open** | OBS `universe.select{region: deployment}` | — |
| 5 | Encounter Reel with breadcrumb chip "**From Deployment**", 0:35/0:50 (U04-2) | tap the **From Deployment** chip (= Back) | OBS `reel.visible_interval` | navigate/activate (explicit target from region) |
| 6 | Region again: "**You were here**", same camera, ship parked (U04-3) | tap **Visit Ravi's universe** | OBS `universe.return` | — |
| 7 | "Visiting Ravi · only what he shares" + Leave + "Some of Ravi's universe is private." (U06-1) | tap **Model serving room — same room as on your map** | CMD `visit.open{handle: ravi.m}` | (gap: visit route) |
| 8 | Room "Model serving room · Same room as on your map · opened from Ravi's": pinned thread "What one answer costs to serve", what-if card "What if requests increased tenfold? · Same model and hardware · Explore this →", **AI · Skeptic** suggestion "what if requests arrive in bursts instead?" Explore this / Dismiss, "Reply in this thread" (R02) | Restart | CMD `room.open{roomId: model-serving}` | `GET /v1/rooms/:id` |

**Test assertions (J3):** map selections emit observations only (no evidence, no world growth); exact camera return (system/planet/region/zoom/rotation) with the encounter paused at its playhead; the breadcrumb behaves exactly like Back; the visitor scene is server-filtered and the private-parts haze is generic; the same room ID is reached from a different map position; an AI suggestion never commissions without a human "Explore this".

## Journey 4 · Recovery & privacy (7 steps)

| # | Screen (artboard) | Hotspot action | Emits | Blueprint contract |
|---|---|---|---|---|
| 1 | Chat with Ravi: "Did Part 2 load for you?" / "Yes — watching now" / my bubble "The event-horizon bit is the key" **Not sent · Retry** (C02-2) | tap **Not sent · Retry** | CMD `message.send{requestId: r-41}`; no receipt (connection dropped) | `POST /v1/conversations/:id/messages` |
| 2 | Same bubble "Sent · same message, not a copy" (C02-2) | tap **Simulate a dropped connection** | CMD `message.retry{requestId: r-41}`, Receipt `message.committed` | same route, same requestId |
| 3 | "Reconnected. Missing messages added in order." + divider "While you were away" + two messages (C02-3) | tap **Next: open a revoked link** | socket reconnect `{cursor}`; receipts replayed in order | `GET …/messages?after=cursor` |
| 4 | Web landing "**Link ended** · Asha stopped sharing this link · It no longer opens for anyone. Nothing about what it contained is shown here." (H02-4) | tap **Go to KnowScroll** | `share.access_decision = revoked` | `GET /s/:shareToken` |
| 5 | Privacy & history with "Recording paused" banner; the switch Off; rows History & export / Clear exploration / Delete account "Everything, including conversations you started" (P02-1/2) | tap **Clear exploration** | CMD `privacy.recording.set{on: false}` | privacy endpoint (pause) |
| 6 | Clear exploration confirm: what's removed / what stays, checkbox "I understand this can't be undone" (P02-4) | tick + tap **Clear exploration** | confirmation only | — |
| 7 | Receipts: "**Clearing in progress** · Started today. We'll mark this complete only when every copy is cleared." + failure copy (P02-5) | Restart this journey | CMD `privacy.clear_exploration`, Receipt `pending → completed | failed` | privacy endpoint (clear) + privacy epoch |

**Test assertions (J4):** retry reuses the request ID and yields one bubble; catch-up is ordered by server cursor and inserted under a divider without jumping; a revoked share reveals no content metadata; paused recording produces no growth and no later back-fill, while Save/Share/Talk still work; clear exploration needs an explicit acknowledgement, advances the epoch, purges client scoped caches/buffers, and never reports completion before every store confirms (receipt pending → completed | failed).

**Copy conflicts inside J4 (storyboard vs P02 v2.1):** (a) J4-5 "Delete account · **Everything, including conversations you started**" vs P02 "Removes your account, universe, Keep and **messages you sent**". The storyboard copy conflicts with §19 ("do not silently delete an entire shared conversation"), so **use the P02 copy**. (b) J4-7 "We'll mark this complete only when **every copy** is cleared" vs P02 v2.1 "Cleared from KnowScroll (completes) + Backups · pending within [N days]". The v2.1 decision (Main: "Honest promises") supersedes, so **use the P02 two-line receipt**. (c) J4-4 shows the sender name to whoever opens the link (see the H02 flag).

## Journey 5 · Back, step by step (8 steps) — navigation rules (N01; the N01 board is covered by the other agent)

| # | Screen | Hotspot action | Emits | History stack effect |
|---|---|---|---|---|
| 1 | Part 1 Reel at 0:31 (came from an Astronomy Reel) | tap **Scroll** (seg) | CMD `format.switch{to: scroll}` | push (a format switch is a history entry) |
| 2 | Part 1 Scroll at its end card: "End of this Scroll", **Part 2 · Attention at work** / Related · A spotlight with a budget / Next subject | tap **Part 2** | OBS `scroll.block_coverage`; CMD `thread.continue{relation: series}` | push |
| 3 | Part 2 Reel ("To translate 'chat', the model looks hardest at 'cat'."), 0:18/0:50 | tap **Share** | OBS `share.sheet_opened` | none (overlay is not an entry) |
| 4 | Share sheet "Part 2 is paused underneath at 0:18" | tap **Close** (or Back/Esc) | OBS `share.sheet_cancelled` | unchanged |
| 5 | Part 2 "Playing again from 0:18 — closing Share didn't move you." | tap **Back** | none | — |
| 6 | Back #1 → Part 1 **Scroll at the end card** ("Back where you were") | tap **Back** | history pop | pop |
| 7 | Back #2 → Part 1 **Reel paused at 0:31** ("Paused where you left it") | tap **Back** | history pop | pop |
| 8 | Back #3 → the **Astronomy Reel paused at 0:12**; one more Back follows platform convention (leave the app on Android, previous page on web) | Restart | history pop | pop |

**Test assertions (J5):** overlays close first and are not history entries; closing an overlay resumes playback (it was not a detour); Back after a real detour lands **paused**; Back is the user's own path, never "previous part" (→ swipe/edge tab is a different command); each step keeps its own anchor (Part 2 keeps 0:18 when going forward again); browser Back = native back edge = in-app Back.

## Journey coverage gaps vs the brief's "connected prototype journeys"

- Brief J2 asks for "**Ravi joins** and Meera arrives later": the storyboard has no join step (C03 covers the join UI). Add a test **Ravi: Talk card → Preview → Join thread**.
- Brief J2 "share passage/block settings" and "explore an alternative branch": not in the storyboard. Use H03-2/3 and X03-3 as additional test steps.
- Brief J4 (rooms): the room path is folded into J3-8 only (no "create/open a room content thread → share a snippet → choose a suggestion → ready → return", and **no "second discussion stays unaffected"** demonstration). Add a room journey test built from R02 frames 1–2 + X02/X03.
- Brief §17 acceptance "one joins later → navigate episodes independently" and "socket catch-up, hidden/expired availability, absence of peer playback fields" need explicit test assertions (API-level: ThreadView contains no other member's playback/seen fields).

---

# COVERAGE MATRIX

Proposed Expo Router layout: `app/(auth)/…`, `app/(tabs)/{explore,universe,conversations,saved}` (labels "Explore · Universe · Talk · Keep" per v2.1; route names follow the blueprint), modal/overlay routes for sheets, and stack routes for details. "Gap" means the blueprint §7 has no route yet; a proposal is given. ✗ = state required but not drawn.

| Surface / state | Artboard(s) | Proposed Expo Router route | Backend contract(s) | Notes |
|---|---|---|---|---|
| Welcome / sign in | A01-1 | `/(auth)/welcome`, `/(auth)/signin` | auth (gap: not in §7; provider TBD) | ✗ email form, ✗ loading/redeeming, ✗ offline |
| Link sent / resend | A01-2 | `/(auth)/signin/link` | auth request-link | rate-limit copy needed |
| Session expired (held destination) | A02-1 | `/(auth)/recover?next=` | auth | destination only from same-account local scope |
| Link failed | A02-2 | `/(auth)/recover?reason=link` | auth | |
| First arrival + hint | A03 | `/(tabs)/explore` | `POST /v1/experience/open`, `…/activate` | hint once per account+device |
| Reel playing | E01-1, E09-1/3 | `/(tabs)/explore` (feed) · `/reel/[assetId]?rev=&t=` | open/navigate/activate; `POST /v1/actions`; `POST /v1/observations/batch` | ✗ loading, ✗ ⋯ menu drawn on E01 |
| Reel paused + transcript | E01-2 | same + sheet | client | captions = P01 default |
| Buffering / offline | E01-3 | same | client retry | ✗ buffering-only |
| Corrected asset | E01-4, H02-5, S01-3 | same | asset revision + correction note | banner once per person |
| Unavailable / withdrawn | E01-5, H01-5, H02-4 | same | revision status | ✗ non-Keep variant copy |
| Scroll reader | E02-1/2, E09-2/4, H03-2 | `/scroll/[assetId]?rev=&block=` | navigate/activate; observations (block coverage, dwell) | do **not** use `/s/` (share tokens) |
| Scroll end boundary | E02-3, J5-2 | same | navigate (series/related/vertical) | momentum guard (web boundary detector) |
| Scroll block fallback / partial offline | E02-4 | same | block render diagnostic (internal) | ✗ loading skeleton, ✗ corrected Scroll |
| Interactive blocks | E03, E09-4, H03-3, J1-5 | (inside the Scroll reader) | block state local by `(rev, blockId)`; obs `block_interaction` | see the Scroll DSL section |
| Ask / topic request | E04-1..4 | modal `/(modals)/ask` over the encounter | `POST /v1/content-requests`; `GET /v1/content-requests/:id` | gap: cancel route; ✗ sending/offline |
| Horizontal continuation (Part / Related) | E05-1/2, E09 | same encounter route `?thread=` | `POST /v1/experience/navigate` (series|related|previous) | edge tabs start 24px in |
| Thread trail sheet | E05-3 | overlay | client + server thread view | caller-only statuses |
| Exhausted thread / corrected prior | E05-4, E07-4 | encounter route (end state) | navigate → `exhausted` | |
| Format switch (exists / preparing / ready) | E06-1/2/3 | encounter route | navigate (format variant) or `POST /v1/content-requests` | ✗ unavailable, ✗ Scroll→Reel |
| Supply: requests sheet + chip states | E07-1..3, S01 Requested | `/(tabs)/saved?view=requested` or sheet | `GET /v1/content-requests?status=` (gap), `GET …/:id`; retry (gap) | ✗ stale/offline chip |
| Natural ending / way back | E08-1..3 | encounter route (end state) | `POST /v1/actions` save with anchor (gap: thread return target) | ✗ way back failed |
| Keep library / empty / changed | S01-1..3 | `/(tabs)/saved` | gap `GET /v1/saved` | ✗ loading, ✗ offline, ✗ remove-failed |
| Keep detail / resume | S02 | `/saved/[itemId]` | navigate with anchor | ✗ Reel detail variant |
| Universe overview (empty/emerging/established/returning) | U01-1..4, U08-1 | `/(tabs)/universe` | `GET /v1/universe` (revision-aware) | ✗ loading, ✗ offline, ✗ error |
| Mature universe: LOD / select / search / outline | U08-1..4 | `/(tabs)/universe?focus=`, `/universe/search`, `/universe/list` | `GET /v1/universe` (client index) | ✗ near zoom, ✗ no-match |
| Topic system (established/forming/calm/list) | U02-1..4 | `/universe/system/[systemId]` (`?view=list`) | `GET /v1/universe` | ✗ hidden/private boundary on own map |
| Planet close-up / region focus / low detail | U03-1..3 | `/planet/[planetId]` | `GET /v1/universe` | ✗ pending pin, ✗ offline |
| Region card / encounter entry / exact return | U04-1..3 | `/planet/[planetId]?region=[regionId]` → `/reel/[assetId]?from=region` | navigate (explicit target / region-scoped intent) | ✗ encounter unavailable, ✗ offline card |
| Formation transition | U05 | overlay on `/(tabs)/universe` or a system | `GET /v1/universe` deltas (transitionId); obs shown/skipped | gap: seen-transitions per account |
| Personal world rules | U07 | (renderer spec, no route) | scene descriptor fields (seed, material, light, landmarks) | not a consumer screen |
| Friend visit / station / private / revoked | U06-1..4, J3-7 | `/visit/[handle]` | gap `GET /v1/visits/:handle/universe` | ✗ denied, ✗ loading |
| Share sheet (4 ways) | H01-1, J2-1, J5-4 | modal `/(modals)/share?asset=&rev=&t=` | obs sheet_opened/cancelled | overlay, not history |
| Send to a conversation | H01-2 | modal step | `POST /v1/shares` (+card) or `POST /v1/conversations/:id/messages` | ✗ send failed |
| Explore with friends → Create thread | H01-3/4, J2-2/3 | modal step → `/threads/[id]` | `POST /v1/conversations` + `POST /v1/content-threads` (idempotent) | ✗ 0-selected, ✗ creating |
| Copy link / external / withdrawn block | H01-5 | modal step | `POST /v1/shares` (link) | |
| Share landing: public / private / authorised / revoked / withdrawn / corrected | H02-1..5, J4-4 | `/s/[token]` (web + universal link) | `GET /s/:shareToken` | ✗ denied (signed-in non-recipient), ✗ expired |
| Snippet composer: Reel range / passage / block | H03-1..3, J2-4 | modal `/(modals)/moment?…` | `POST /v1/snippets` + thread message | include-settings default (see flag) |
| Snippet cards + corrected mapping | H03-4 | (in thread) | snippet read with mapping status | ✗ withdrawn, ✗ access-denied |
| Snippet viewer | H03-5 | `/threads/[id]/snippet/[snippetId]` | snippet + source access check | not a history entry |
| Talk inbox (ready/empty/offline) | C01-1..3 | `/(tabs)/conversations` | gap `GET /v1/inbox`; Socket.IO presence | ✗ loading, ✗ reconnecting |
| Thread invitation card | C03-1 | in `/(tabs)/conversations` | gap `POST /v1/content-threads/:id/join|ignore` | ✗ revoked invite, ✗ Hidden list |
| Thread preview (not a member) | C03 (described) | `/threads/[id]?preview=1` | `GET /v1/content-threads/:id?preview` | ✗ not drawn |
| Members sheet / mute / leave | C03-2 | sheet in `/threads/[id]` | thread commands (gap) | ✗ leave confirm |
| Thread ended / left / item withdrawn | C03-3 | `/threads/[id]` | thread state (gap: `ended`) | |
| 1:1 conversation (ready/failed/catch-up/options/membership lost) | C02-1..4, J4-1..3 | `/conversations/[id]` | `POST/GET /v1/conversations/:id/messages` (+`?after=cursor`), Socket.IO | gap: block/report/mute/leave routes; ✗ blocked, ✗ empty |
| Content thread expanded / collapsed / keep listening / keyboard | C04-1..4, J2-3/5 | `/threads/[id]` (`/threads/[id]/item/[itemId]?t=`) | `GET /v1/content-threads/:id`, `POST …/messages` | ✗ **Scroll as thread item**, ✗ full screen |
| Episode browser grid (all states) | C04-5 | `/threads/[id]/all` (sheet) | ThreadView | Preparing not selectable |
| Late joiner (own start) | C04-6 | `/threads/[id]` | ThreadView (caller-only markers) | |
| What-if composer (quick / confirm) | X01-1/3, J2-6 | modal `/(modals)/explore?thread=&source=` | `POST /v1/explorations` (+ gap: draft summary) | ✗ clarify, ✗ perspective composer |
| Branch card states | X01-2, X02-1..3, J2-7 | (in thread) | `POST /v1/explorations/:id/branches`; Socket.IO notice | gap: retry/cancel/remove |
| Branch sequence / branch discussion / perspective / back to original | X03-1..4, J2-8/9 | `/threads/[id]/branch/[branchId]/[itemId]` | `GET /v1/explorations/:id`; thread messages with scope | gap: message `scope/branchId` |
| Branch map | X04-1..3 | `/threads/[id]/map` (overlay) | `GET /v1/explorations/:id` (paged children) | ✗ removed, ✗ empty search |
| Room station card | R01-1 | overlay on `/(tabs)/universe…` | `GET /v1/universe` | |
| Room preview / join / invite-only / paused | R01-2/3 | `/rooms/[id]` | `GET /v1/rooms/:id`, gap `POST /v1/rooms/:id/join` | ✗ removed, ✗ closed |
| Room thread list | R02-1 | `/rooms/[id]` | `GET /v1/rooms/:id` | |
| Room content thread + AI suggestion | R02-2, J3-8 | `/rooms/[id]/threads/[threadId]` | `GET /v1/content-threads/:id` (parent=room); explorations | ✗ second discussion unaffected |
| Moderator tools | R02-3 | sheet | room moderation commands (§7) | none commission production |
| Room retry / removed / quiet + invite AI | R02-4 | same | gap: AI invocation route | |
| Optional room activity (poll/quiz/answers) | R03-1..3 | `/rooms/[id]/activity/[activityId]` | room commands (gap: votes/answers) | ✗ results, ✗ closed |
| Friends list / add / requests & blocks | F01-1..3 | `/friends`, `/friends/add`, `/friends/requests` | gap: friend-requests, invite-links, blocks | ✗ empty |
| Visibility (who can visit / per-system / presence) | F02 | `/account/visibility` | privacy/visibility endpoint; presence setting | ✗ saving/failed |
| Account / sessions | P01-1 | `/account` | gap: me, sessions | ✗ edit profile |
| Accessibility & playback | P01-2 | `/account/accessibility` | gap: settings | |
| Notifications | P01-3 | `/account/notifications` | gap: notification prefs | |
| Privacy hub / recording paused | P02-1/2, J4-5 | `/account/privacy` | privacy endpoints (pause) | |
| Export receipts | P02-3 | `/account/privacy/export` | privacy export (receipts) | ✗ expired |
| Clear exploration confirm | P02-4, J4-6 | `/account/privacy/clear` | privacy clear (epoch) | |
| Clear/delete receipts | P02-5, J4-7 | `/account/privacy/receipts` | receipts read (gap) | ✗ delete confirm screen |
| Feedback menu / not interested / error report / abuse received | P03-1..4 | overlay (no route) | `POST /v1/actions` (not_interested/hide), gap `POST /v1/reports`, blocks | ✗ abuse form, ✗ hidden-subjects view in Keep |
| Prototype journeys | Prototype, Prototype-storyboard | — | — | e2e journey tests (above) |
| Operator appendix | (other agent) | `/operator` (not consumer) | Grafana views | out of scope here |

---

# SCROLL BLOCK KINDS & INTERACTIVE BEHAVIOURS (input for the declarative Scroll DSL)

Sources: E02 (poster article), E03 (block gallery), E09-2 (editorial Scroll), E09-4 (comparison Scroll), H03-2/3 (passage selection, block share), J1-S05 storyboard (square-growth slider), E06-1 / E07-2 / S02 (poster hero reuse), X03-3 (perspective Scroll). The notes name the versioned types `diagram.v1, compare.v1, slider.v1, disclosure.v1, code.v1`. The blueprint §18 contract: immutable block IDs, versioned block types, semantic content, bounded parameters, an implemented component registry, accessibility text + a gesture-capture declaration per block, state persisted by `article revision + block ID`, a safe readable fallback for invalid blocks, **no model HTML/JS**.

## A. Document-level / reader chrome (not authored blocks, but the DSL must carry the data)

| Element | Anatomy (from the export) | Data the document must provide |
|---|---|---|
| **Template** | Two templates seen: **poster** (E02/E06/E07/S02: hero card with 2px ink outline + cobalt offset shadow, heavy Bricolage title) and **editorial** (E09-2: mono kicker "ESSAY · HISTORY OF THE SEA", plain `h2`, drop-cap paragraphs, illustrated figures). E09 rule: "content character comes from the asset (illustration, palette, caption style, block set), never from a different screen template or chrome." | `template: poster | editorial`, `theme` (palette accent, family hue), `kicker?` |
| **Hero / poster** | `tag` topic ("Machine learning"), display title ("Attention, slowly"), standfirst ("The same idea as the Reel, with room to try it yourself."), meta `mono` "A Scroll · 6 min". | `topic`, `title`, `standfirst`, `readMinutes`, sibling Reel id (for the seg + "Same explanation as the Reel …") |
| **Top bar** | ‹ Back + Reel/Scroll seg; compact `mini` header mid-read (‹ + `mono` article title); a decorative cobalt **reading line** at the top edge. | — (client) |
| **Action strip** | Like · Save · Share · Ask pill; "Scroll strip (top + end of article; **floats up on reverse scroll**)" (Components). The NavBar hides while reading and returns at the end. | — |
| **Corrected banner** | "under title" (described, E02 notes) with `tag.cor` "Corrected · <date>" + plain-language change text. | `correction {date, text}` per revision |
| **End mark + end card** | Rule–◆–rule, then "END OF THIS SCROLL" card: yellow "**Continue this idea**" with `[Part 2] title →` (solid) and `[Related] title →` (dashed), **↑ Next subject**, the action strip. | Comes from thread relationships (server), not the article body. |
| **Partial download** | The banner "The rest of this Scroll will load when you're online. What's above stays readable." + hatched skeleton lines. | Blocks must be independently renderable in order (progressive). |
| **Restore highlight** | "Returning … restores the exact anchor and flashes the paragraph (content.highlight)". | Anchor `{revision, blockId, offset}`; revision mapping table for anchors. |
| **Section anchor labels** | The resume copy uses the **nearest section heading** ("At 'Why squared?'", "Third of four sections", kicker "ATTENTION, SLOWLY · 3"). | Headings must be blocks with stable ids and ordinal. |

## B. Content block kinds

| # | Block kind (proposed DSL type) | Seen in | Visual anatomy | Controls & behaviour | State / gesture / a11y |
|---|---|---|---|---|---|
| 1 | `heading.v1` (level 2/3) | E02 (`h3.h2s` "A sentence is a crowd", "Why squared?", "Scores become weights", "What it can't do") | Bricolage bold; real h2/h3 | Landmark/rotor navigation; anchor target | No state. The restore fallback when a block is missing. |
| 2 | `paragraph.v1` (rich text) | E02 `p.prose`, E09 `p.ed`, X03-3 | 18/28 ink body, ~62ch. Inline marks: *italic* (quoted example sentence), **bold** (key words: "animal", "square"), `inline code` (`q @ k.T` on a tinted chip). **Drop cap** variant (`p.ed`, cobalt "F") on the editorial first paragraph. | Native **text selection** → selection toolbar **Share passage · Copy · Ask** (H03-2); the yellow selection highlight. | Passage snippet = `{revision, blockId, textRange, quote}`. No gesture capture. |
| 3 | `figure.matrix.v1` (static data diagram) | E02-2 "EVERY WORD × EVERY WORD" | Bordered card; `mono` label; a 6×6 heat grid (row/col labels in mono: the, animal, street, it, was, tired); cell intensity = weight (cobalt scale); **one highlighted row** (yellow outline: "it"); caption "36 comparisons for six words. The highlighted row is 'it'." | None (static). | `alt` required (aria-label "A six by six grid. Each cell is one word compared with another; darker cells mean more attention. The row for 'it' is darkest at 'animal'."); data-driven (labels[], matrix[][], highlightRow). |
| 4 | `figure.illustration.v1` | E09-2 (ocean swells + canoe svg), E02-1 hero art | Rounded tinted panel with a vector illustration; caption below in small text. | None. | `alt` + caption required. The asset is an approved illustration reference, not model-generated SVG code. |
| 5 | `diagram.wordgraph.v1` (draggable) — design `diagram.v1` | E03-1, J1 | A `blk` card with title "Drag 'it' toward another word"; a cobalt canvas with word chips; a draggable focus node (yellow, grip ••••); weighted edges (thickness = attention; the thickest goes to "animal"). Buttons **↺ Reset**, **Describe this diagram**. After-text "Thicker line, more attention." | **2D drag of the focus node** (component owns the drag until release); Reset; Describe → the text alternative. Interacting state = **yellow ring only** ("no ownership wording in the UI"). | `captures: both`. State `{nodePosition}` persisted by `(revision, blockId)`. Alternative = `table` (E03-4 "Where 'it' looks": Word | Attention: Most/Some/Little/Very little). Obs `scroll.block_interaction{blockId, kind}`. |
| 6 | `compare.v1` (two-up comparison) | E03-2 | `mono` label "TWO WAYS TO READ"; two side-by-side cards (title, mini illustration: fading chain vs all-to-all dots, body text); the "winner" card tinted yellow. | None (static) in the drawing. | No capture. Alt = the text of both cards. |
| 7 | `slider.v1` (parameter explorer) | E03-2 ("~64×" result), J1-S05 / H03-3 (square-growth visual) | A `blk` card: title "Try a longer sentence"; current value top-right "4,096 words" / "1,024 words"; **visualisation** variants: (a) **big result number** "~64×" + explanatory sentence "the work of 512 words. Eight times longer, about sixty-four times the work."; (b) **length bar + work square** (black bar labelled LENGTH; yellow square whose area ∝ n²) + "Work grows about 4× while the text grows 2×." `label` "Sentence length", a track with endpoint labels "512 WORDS … 4,096 WORDS". H03 uses `input[type=range] min=0 max=3` = **4 discrete stops** (512, 1,024, 2,048, 4,096). | Drag the thumb (horizontal) or keyboard (arrow ±1 step, Home/End); spoken valuetext. | `captures: horizontal` (wins only after the horizontal axis is locked). State `{stopIndex}`. Alternative = **stepper** (E03-4: − Shorter / `role=status` "4,096 words · about 64× the work of 512" / + Longer). Shareable params: `{length: 4096}` ("Length 4,096" tag on the snippet card). The derived output must be declarative (see C). |
| 8 | `disclosure.v1` | E03-3 | Yellow header bar button "Why squared?" with chevron (`aria-expanded`), body text below. | Tap toggles expanded/collapsed. | `captures: tap`. State `{expanded}`. |
| 9 | `code.v1` | E03-3 | Dark card; `mono` label "PYTHON · ATTENTION"; **Copy** button (→ "Copied"); syntax-highlighted `pre` (keywords yellow, function names teal); an **inner horizontal scroll** with a visible scrollbar. | Copy to clipboard; horizontal scroll inside the block; focusable for keyboard scrolling (aria-label "Code example, scrolls horizontally"). | `captures: horizontal-scroll` (inner). State: none (copied is transient). |
| 10 | `table.v1` (data table / text alternative) | E03-4 | Bordered card; `mono` label "WHERE 'IT' LOOKS"; caption "Attention from 'it' to each word"; header row Word | Attention; rows with the first column bold for the top value. | None. | Used both as a standalone block and as the **alternative** rendering of diagrams. |
| 11 | `calculator.scale.v1` (input → derived result cards) | E09-4 "How heavy would you be on other worlds?" | A card with a cobalt offset shadow: `label` "Your weight on Earth"; **stepper** (− Less / yellow value field "60 kg" / + More); a 2×2 grid of result cards `wcard` (world dot in its hue, name, `mono` multiplier "0.17×", big value "10 kg", proportional bar `wbar`); footnote "Jupiter has no ground to stand on; this is at its cloud tops." | Numeric input (numeric keyboard on native), stepper buttons, announced results. "The interactive block is the experience." | `captures: none` (taps/typing). State `{weightKg}` persisted by `(revision, blockId)`. **Personal value: must be `shareable: false` by default** (see the E09/H03 flags). Output = input × factor per row (declarative). |
| 12 | `fallback` (renderer-generated, not authored) | E02-4 | Dashed box: `mono` "DIAGRAM COULDN'T LOAD · TEXT VERSION"; the block's text alternative; **↻ Retry diagram**. | Retry re-renders the block. | Requires every interactive/figure block to carry an `alt.text` (and ideally `alt.table`). "Never a blank block." Internal diagnostic emitted. |

**Reader-level controls affecting blocks**

- **"Text version of diagrams"** `role=switch` (E03-4) swaps every diagram/slider to its declared alternative (table/stepper). The DSL needs a per-block `alternative` render.
- **Revision changed**: "state reset with notice" when there is no compatible migration (E03 notes). The DSL needs `stateSchemaVersion` + optional `migrate` mapping per block type version.
- **Block share** (H03-3): the sheet "Share this diagram" with **Include how I set it** (switch) showing the exact params ("Sentence length 4,096"); a card preview "DIAGRAM · ATTENTION, SLOWLY / Try the diagram with sentence length set to 4,096 / [Length 4,096]"; the recipient opens it via **Open as set**. The DSL needs `shareableParams` (an allowlist) + a human-readable param label template.
- **Passage share** (H03-2): selection inside paragraph blocks only (and maybe table cells). Requires stable text offsets per block per revision.
- **Restore**: anchor = `revision + blockId + offset within the block`; per-block state restored; the paragraph flashes on return.
- **Gesture arbitration** (§18 + E03 notes): "Each block declares *captures gesture* yes/no; the article never steals a gesture a block has claimed." Axis lock: the slider wins only after the horizontal lock; the diagram wins the 2D drag; code wins the inner horizontal scroll; vertical reading otherwise; reaching the end → boundary, not navigation.
- **Observations**: `scroll.block_coverage{blockId}` (weighted section coverage), `scroll.active_dwell`, `scroll.block_interaction{blockId, kind}` (deliberate interaction only, summarised, no raw pointer frames).

## C. Proposed DSL shape (sketch to start from; derived from the above)

```ts
type ScrollDoc = {
  id: string; revision: string; explanationId: string;          // shared with the Reel sibling
  template: 'poster' | 'editorial'; theme: { familyHue: string; accent?: string };
  hero: { topic: string; title: string; standfirst?: string; kicker?: string; readMinutes: number; art?: IllustrationRef };
  correction?: { date: string; text: string };                    // authored, shown as "Corrected · <date>"
  blocks: Block[];                                                // ordered; each renders independently (partial download)
};
type BlockBase = {
  id: string;                    // immutable across revisions where meaning is kept
  type: string; version: number; // e.g. 'slider' v1
  captures: 'none' | 'tap' | 'horizontal' | 'both' | 'inner-scroll-x';
  alt: { text: string; table?: TableData };   // required for figure/diagram/slider/calculator
  stateSchema?: ParamSchema[];   // bounded params (enum stops / min-max-step numbers / booleans)
  shareable?: { params: string[]; label: string };  // allowlist + template, e.g. "Length {length}"
  personal?: string[];           // params that are personal data → never shared by default
};
// derived outputs: no code. Either an enumerated lookup per stop
//   outputs: { [stopIndex]: { headline: '~64×', sentence: '…' } }
// or a whitelisted arithmetic expression over bounded params evaluated by a vetted interpreter
//   e.g. { value: 'weightKg * factor', format: '{value:0} kg' }
```

**Block types needed for v1** (from the export): `heading`, `paragraph` (marks: em, strong, code; `dropCap`), `figure.matrix`, `figure.illustration`, `diagram.wordgraph`, `compare`, `slider` (visual: `resultNumber` | `lengthSquare`), `disclosure`, `code`, `table`, `calculator.scale`, plus the renderer-only `fallback`. **Not seen but implied** by the brief ("rich approved blocks"): callout/aside, pull-quote, image with caption, ordered steps. They are not drawn, so do not design them yet.

---

# CROSS-CUTTING FINDINGS (summary)

**Conflicts with the blueprint or product rules (resolution: blueprint governs behaviour, v2.1 governs visuals)**

1. **Epistemic label taxonomy is inconsistent.** Consumer artboards use "What if" + "Speculative"; the storyboard and Components use "What if · Hypothetical"; Main says only "Hypothetical" and "Corrected" survive. → Store `hypothetical` on every what-if branch and its continuations (§17) plus an optional `speculative` flag. Render "What if · Hypothetical" always and add "Speculative" when flagged.
2. **Snippet block settings default ON** (H03-3) vs the open decision "opt-in toggle" and §17's "no private state shared by accident". The E09 weight value would travel in a snippet. → Default off for personal params; allowlist only.
3. **Share-landing revoked copy names the sender** to anyone with the link (H02-4, J4-4). → Name only for authenticated former recipients.
4. **Route collisions/mismatches:** the design's `/s/:id` (Scroll) and `/share/:token` vs the blueprint's `GET /s/:shareToken`; also `/t/` vs `/thread/`. → `/s/[token]` for shares only; `/scroll/[assetId]`; `/threads/[id]`.
5. **"Summary computed locally"** for what-if assumptions (J2-6) is not feasible client-side. → Add a server draft/preview command with no commission.
6. **4 tabs** (Explore · Universe · Talk · Keep) vs the blueprint's recommended 3 + reachable Saved/Account. Allowed (an open decision), but account is reachable only via the avatar on Keep/Universe.
7. **The ⋯ menu lacks "Next subject"** (P03-1), but A03/E01 cite it as the swipe-up equivalent. The ⋯ button is not drawn on E01 at all.
8. **"Finished"** in the E05 trail reads like a completion grade. → Coverage-policy-derived "Watched ✓", or nothing when unknown.
9. **Storyboard copy is stale vs the v2.1 decisions:** J4-5 delete copy "conversations you started" (conflicts with §19), and J4-7 "complete only when every copy is cleared" (superseded by the two-line receipt). → Use P02.
10. **The room "Scroll version" as a navigator chip** (R02-2) blurs the format variant into the sequence. → Use the seg.
11. **What-if/perspective cards in the C04 grid** must distinguish suggested vs admitted (§18 branch history).
12. **Drawing inconsistencies in the rail** (Ask missing on E01-4, E04-3, U04-2; seg centred on U04-2; no rail on the J2-8 branch Reel). → The E09 rule (fixed rail Like·Save·Share·Ask, seg top-right) governs.
13. Compliant areas worth keeping as test oracles: no peer playback/seen positions anywhere (markers are always "your own"); AI inhabitants are labelled with role tags and a distinct dotted square bubble; no counts in universe/rooms; "Nothing expires" / calm dormant worlds; suggestions are never episodes ("Suggestion · not made"); Reel ⇄ Scroll equal seg; no sources/provenance/scores panels on consumer screens.

**States the blueprint/brief require that no artboard draws (consolidated):** loading for nearly every surface (A, E01, E02, S01, U01–U04, U06, C01, C02, C04, P01); auth email form + redeeming + offline; buffering-only; corrected and unavailable **Scroll**; **Scroll as a content-thread item**; full-screen thread player; single-item thread "Continue this"; thread preview mode; invitation revoked; thread join by Ravi (only Meera's late arrival); denied (signed-in non-recipient) share landing and visit; blocked conversation; message sending (pending) bubble; deleted-sender message marker; what-if clarify question; perspective composer; branch removed/source withdrawn; room removed/closed/access-lost; poll results/closed; abuse report form; delete-account confirm; export expired; settings saving/failed; empty friends; filter-empty Keep; Keep views for hidden subjects and ignored invitations; universe offline/error; near-zoom LOD; formation for an existing system.

**Blueprint §7 route gaps surfaced by the screens:** auth; list routes (inbox, saved, content-requests, receipts); content-request cancel/retry; branch retry/cancel/remove; thread join/ignore/members/mute/leave/end; thread message `scope`/`branchId`; snippet + message as a single command; friends (requests, invite links, blocks); visits; room join/invite-request/activity votes/AI invocation; reports; settings/notifications/sessions; formation seen-transitions; an exploration draft summary.
