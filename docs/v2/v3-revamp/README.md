# v3 revamp: change map and findings

The owner's session wrote these on 29 October 2026 against `dev` at `5d1271d5` (schema `0068_feedback`). They map the final designs in `../design/v3/` onto the code.

- `CHANGE-MAP.md`: read this first. For each visible change, the matching change in contracts, Cartographer, Composer, Planner, evidence, room AI and client; the conflicts; the order of work.
- `findings-universe-cartographer.md`, `findings-scrolls-recommendation.md`, `findings-rooms-talk.md`: the detail behind each part.

**A starting map, not proof.** The findings were written by reading the code; nothing was run. Verify a claim against the code before you build on it.

The files are copied unchanged. Their package paths `01-designs/...` now live in `../design/v3/...` (for example `01-designs/universe/` is `../design/v3/universe/`). The rule changes in CHANGE-MAP section 4 are recorded as decisions D-060 onward in `../decisions.md`.
