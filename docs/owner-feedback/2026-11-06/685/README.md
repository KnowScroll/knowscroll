# Talk created-thread navigation (#685)

These are **labelled HTTP fixtures in Chromium**, not live dev accounts or product activity.
The production Expo export runs under the normal edge headers. All names and content are authored fixtures.

Before: `b5390c25`. After: the #685 change on `d962c045` (latest dev, including #701).
Both Start a thread and Watch together left the conversation visible after Open thread at
390×844 and 1440×900. The fix reuses D-238's `closeThen` helper to wait for the sheet's Back
before pushing the exact thread and membership returned by creation.

| Viewport | Before: conversation remains | After: created thread opens |
| --- | --- | --- |
| 390×844 | [Before](before-390.png) | [After](after-390.png) |
| 1440×900 | [Before](before-1440.png) | [After](after-1440.png) |

`apps/client/e2e/share-open-smoke.spec.ts` passes all eight cases: the existing Share-sheet
flows; Talk's two creation entries at both widths; a double press followed by an identical-command
retry after a lost response; and unavailable membership. Talk checks include the shared Scroll,
participant-addressed composer, reload, direct entry and no encounter or chat-send commands.
The four new Talk navigation cases failed on the unchanged export before the fix.

Related checks: 41 component/helper tests, seven existing thread-creation controller tests,
client typecheck, changed-file lint, formatting and diff checks. The first cold component run
timed out in two existing tests; the unchanged suite passed when rerun and after the dev sync.

Live dev acceptance is pending the merged #685 deployment. These captures do not establish
physical phone/native behavior, real invitations or backend availability.
