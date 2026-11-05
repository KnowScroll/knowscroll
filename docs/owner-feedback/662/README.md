# Desktop Universe evidence (#662)

The owner supplied `owner-before.png` in #662. The `before-dev-*.jpg` captures reproduce it on
signed-in dev at commit `f92d9ac7a33065bd99c8f1e2d07b2f49439e5cb2`, with the formed Space system
and its room. These are actual dev views, not fixture data.

The `before-fixture-*.png` / `after-fixture-*.png` pairs use the same labelled authored HTTP
fixture, reduced motion and 900 px height at 1024, 1440 and 1920 px. Before is an Expo production
export of the base revision above; after is this PR's export. This isolates the layout change
from account geography. The fixture is not evidence of real personal activity or formation.

| Width | Before | After |
|---|---|---|
| 1024 | [Before](before-fixture-1024.png) | [After](after-fixture-1024.png) |
| 1440 | [Before](before-fixture-1440.png) | [After](after-fixture-1440.png) |
| 1920 | [Before](before-fixture-1920.png) | [After](after-fixture-1920.png) |

The map reaches the right viewport edge at all three desktop widths. Browse and Settings overlay
it without changing the map bounds. Browser tests exercise browse/search → choose a place → close
→ continue exploring, selected-place preservation, autofocus, Escape, browser Back, `/`, zoom,
Back/up, Return, Settings and manual Simple drawing. Context-loss coverage checks the automatic
accessible list separately. Phone, collection/Resume, visits and axe checks retain their existing
journeys; their desktop entry points now open Browse or Settings.

Scope teardown during a gated drawing reload, preference storage and visit exclusions are covered
by focused component/session tests. See the PR for command results, fresh review and post-merge
deployment verification. The frozen design exports were not edited.
