You are my product designer and interaction-design teammate for KnowScroll. Create or revise a complete, editable, Figma-like UI design and clickable prototype for all pages. If the KnowScroll-design-v1 export is supplied, preserve its theme and iterate its existing frames using the updated brief. This is a design iteration on our existing theme, not a backend implementation task. Do not use PIO or the Software Factory workflow.

Read the attached `03-design-brief.md`, `design-references/README.md`, positive reference images and, if attached, `02d-greenfield-blueprint.md`. The new brief governs product behaviour. Old screenshots and HTML are visual references, not current functionality or permission to reproduce old mechanics. First show a short reference audit: what you will preserve, refine and replace. Then produce the full design; do not stop at a moodboard, landing page or a few disconnected hero screens.

PRODUCT
KnowScroll is an enjoyable, low-effort scrolling app where thoughtful encounters gradually become an explorable personal universe. It offers self-recognition without saying “you learned this,” “you believe this,” or assigning learning scores. Reels and interactive Scroll articles are equal. No compulsory onboarding questions, tests, streak pressure or disappearance of worlds after inactivity. Content should feel as thoughtful and readable as an excellent article and as visually engaging as a good Reel. Keep research, model reasoning and debugging out of ordinary consumer screens.

VISUAL DIRECTION
Evolve the existing two-register identity:
- Content/social: warm cream #FFFBF0, near-black #111111, cobalt #2C46E8, yellow #FFE44D, teal #14C79B; bold editorial typography, crisp outlines, generous reading rhythm and rich diagram blocks.
- Universe: spacious deep-blue space, teal oceans, angular continents, delicate orbit lines, restrained star glow and cream floating controls. Existing web space tokens are #050B19 and #0B1630; older Cosmos references use #03101A and #061A27. Unify deliberately rather than combining tokens randomly.
- Bricolage Grotesque headings, Instrument Sans body and DM Mono-style small labels. Preserve character while improving hierarchy and accessibility.
Avoid generic SaaS dashboards, purple-gradient AI styling, overlapping globe labels, oversized metadata sheets and the explicitly rejected grey Worlds dialog. Do not copy obsolete source/debug panels from reference screenshots.

PLATFORM
We selected ONE Expo application: Android/iOS use React Native; browser uses React Native Web. Design shared components and familiar behaviour with responsive adaptations, not a shrunken desktop layout. Use phone 390×844 and desktop 1440×900 as main frames; include compact phone, tablet, landscape, larger text and reduced-motion variants. Keep 2D/canvas versus 3D open. Start with a strong 2D visual solution; 3D is optional. Articles, chat and ordinary controls must remain accessible UI rather than an all-canvas interface.

COMPLETE SCOPE
Use the frame IDs and detailed state requirements in the brief. Cover:
1. Entry, sign-in/recovery and first arrival without an interest survey.
2. Dimensional TV Reel feed, full Scroll reader, interactive article blocks, optional topic request, horizontal continuation, Reel/Scroll conversion, generation waiting/failure and natural thread ending.
3. Saved library and resume.
4. Universe empty/emerging/established/returning states, topic system, planet close-up, regions/topic cards, formation storyboard and friend-universe visits.
5. Share sheet, public/private share landing, access invitation and revoked/unavailable content.
6. Conversation inbox/detail and INTEGRATED CONTENT THREADS: friend selection, scoped invitations, episode navigator, collapsible player, replies, snippet cards, typing/reconnect/send-retry states and block/report.
7. Inline What-if and Another perspective input, assumptions/lens, branch suggestions, pending/ready Reel/Scroll sequence and an optional secondary branch-history view.
8. Cosmic-room preview/discussion with the SAME content-thread, snippet and What-if components scoped to a particular discussion, clearly labelled AI inhabitants, separate moderator and optional room activities.
9. Friends/invites, visibility settings, account, notifications/accessibility, recording/privacy/export/reset/delete and feedback/report flows.

INTERACTIONS
Vertical browsing changes subject; horizontal browsing continues the current idea. A declared Part 2, a related explanation, a format variant and a hypothetical branch are different relationships: make their cues distinct. In a Scroll, vertical movement reads first; residual momentum at the article bottom must not navigate away. Sliders/diagrams keep their own gestures. Provide visible alternatives, keyboard access and native back behaviour. Restore article, playback, branch and camera positions on return.

A system is a broad topic, its star is the organising centre, planets are subtopics and regions are finer areas. Formation follows accumulated exploration, including passive encounters; show no scores or thresholds. Dormancy becomes calmness, not destruction. Two friends can have visibly different ML systems while sharing recognisable visual meaning. One room can appear in different positions on their maps. Do not assign a new meaning to moons, supernovas or black holes.

SHARED STORY — UPDATED AFTER THE FIRST DESIGN REVIEW
Use one integrated content thread, not a mandatory chain of chat → invitation → separate scenario workspace. On mobile show participants, a horizontal episode strip, collapsible Reel/Scroll, messages/snippets, inline exploration cards and a composer. On desktop content can sit beside discussion. Full-screen playback returns to the same thread/message anchor; only one player runs.

Share offers Send to a conversation, Explore with friends, Copy link and external share. Explore with friends opens search/recent friends, checkboxes and Create thread · N friends. Availability is visibility-controlled Online/Recently active/unknown; never show watched topics. A single Reel/Scroll is enough to start a thread. New people receive scope-aware invitations; existing authorised participants do not rejoin for every branch.

Build a clickable Asha/Ravi/Meera journey: Asha watches an ML Reel, follows a continuation, requests its Scroll and tries a diagram. She shares into a new content thread with two friends. Ravi joins; Meera arrives later. The episode strip uses distinct thumbnails and actual numbering, caller-only viewed/current markers and quieter but selectable upcoming ready episodes. Preparing is a separate state; suggestions are not already-created videos.

Asha shares 00:18–00:31 with a message. Ravi opens that range and returns to the same discussion position. Show a Scroll passage and a diagram shared with an explicitly included configuration too. Snippets reference original content; no new clip export is required. Show corrected, unavailable and denied-source variants.

From the snippet Ravi asks What if requests grew tenfold while model/latency target stayed fixed? Inline suggestions offer batching versus additional instances. Choosing one commissions a continuation; a complete direct request can skip the choices. Show preparing, ready sequence, alternative branch and return to discussion. Another perspective changes the explanatory lens without pretending assumptions changed. Retain hypothetical labels on counterfactual content. Keep the branch map secondary.

Share messages, snippets and explicit branch contributions; keep each person’s seen markers, current episode/branch and playback position private. “Ravi requested More instances” is valid; “Ravi is watching Part 1” is not. Nobody’s player follows another’s and universes never merge.

Add universe → system → planet → region → encounter → exact return → friend’s distinct universe → shared idea room. Within ONE room discussion, repeat snippet → What-if/perspective → selected continuation → discussion. Show a second discussion unaffected. The moderator can organise/pin and labelled AI inhabitants can suggest/discuss; neither automatically starts generation. Private friend-thread context is not visible in rooms.

STATES AND HONESTY
Show applicable ready, empty, loading, pending, offline, reconnecting, failed/retry, denied/revoked and corrected/unavailable variants. Show cancelled/copied/sent shares separately and prevent duplicate-message appearance on retry. Do not invent generation percentages, active-human counts or learning claims. Use believable authored sample content and clearly identify the artifact as design/prototype data. Label AI participants and hypothetical scenarios in the UI. Keep optional room quizzes out of the everyday feed.

DELIVER
Produce an editable design workspace with semantic tokens, typography/motion rules, reusable components/variants, all page frames, responsive/state sheets, clickable journeys and a frame-coverage index. Annotate commands/observations, gesture ownership, restoration and accessibility OUTSIDE consumer screens. Include H03 snippet states and R04 room-thread states from the updated brief. Keep episode-strip, article/block and message-list gestures distinct; explicitly demonstrate Back and return restoration. If native Figma output is unavailable, create an interactive design artifact with a page index and editable source; state its actual format honestly. Give a concise comparison to our current theme and list unresolved design choices. Add only a small separate operator appendix for the existing-tool logging views described in the brief; no consumer debug dashboard. Do not implement or deploy the production application.
