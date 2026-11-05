# Room resident verification — #668

## Baseline: live dev, 5 November

Revision `6cb66b718756113b6438b84e916dee1b9c7bb09d`, migration `0104_draft_recording_paused`;
health OK, API and worker active. A newly created disposable account joined Space room with Lively AI,
keep-out off and recording on. Tests used separate, clearly named topics; screenshots show only test messages.
Browser sizes: 1440 × 900 and 390 × 844. The phone size is browser emulation, not a physical phone.

| Scenario | Expected | Observed on baseline | Latency |
| --- | --- | --- | --- |
| `yooo`, then plain Ask | Social acknowledgement or silence | Coverage fallback, `completed / no_ground`, no provider attempt; visible after reload | <1 s worker settle |
| Direct, answerable planet-shadow question in its own topic | Checked resident reply, durable on reload | `asked / mention` → `rooms.contribute` → writer and support attempts → `completed / cleared`; labelled reply visible after reload | 6.9 s admission to commit |
| Ordinary unanswered planet-shadow question | Wait for humans, then a checked reply or intentional silence | `rooms.cast-due` scheduled at +90 s → `caps_clear` → `rooms.cast-pass` → writer, check, rewrite, check → `completed / cleared_after_rewrite`; visible after reload | 102.5 s admission to commit |
| Direct seasons question in Space | Honest missing-support response | No matching ground in this room’s topic; fixed coverage line, no model call | 0.43 s |
| Direct star-collapse question after the seasons exchange | Answer or honest unsupported result | One successful writer attempt returned not covered; committed coverage line, visible after reload | 5.1 s |

The first divergence for the greeting is the plain-ask worker’s passage lookup: it lacks the social guard that
mentions already have. The historic owner greeting’s turn also records `ask_kind=ask`, `no_ground`.
The missing-reply report was **not reproduced** by the direct and unanswered-question checks. No lost job,
failed transport or committed-but-missing client message was observed. A scheduled ambient wait and a
missing-support refusal are different from a lost reply. No second response path was added for that report.

[Before, desktop](before-desktop.png) · [Before, phone width](before-phone.png).

## Automated changes and checks

D-396 records the new greeting-triggered starter and ten-minute contextual follow-up. The existing queued
answer path, recording fence, ambient budget, retries and strict support pipeline remain the owners.
The regressions cover plain social asks, contextual follow-ups, removed preceding messages, starter cooldown,
redelivery, human replies before routing and during a provider wait, keep-out, Off/Quieter, budget refusal,
and typing holds. Fixture model output is not a live observation.

The PR records exact check results and post-deploy observations. Real-service after screenshots require the
feature’s dev deployment. Physical phone/native behavior and a reproduction of the reported missing reply
remain unverified unless a later PR comment explicitly adds that evidence.
