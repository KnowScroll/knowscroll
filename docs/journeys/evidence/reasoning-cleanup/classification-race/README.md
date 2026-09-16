# J004 first-observed failure classification — issue #57

## Retained Linux observation

At PR #65 head `0b88460ab4d8282736cd57c74a3796cf2e44f8f8`, [PR CI35112506042](https://github.com/KnowScroll/knowscroll/actions/runs/35112506042) failed the single-SIGINT case with `failure_classification_mismatch`. [The matrix](ci-before-matrix.json), [final manifest](ci-before-manifest.json) and [runner receipt](ci-before-runner-receipt.json) are original downloaded artifacts, not reconstructed evidence.

Cleanup itself succeeded: final acknowledgement, no cleanup errors, database absent, all child process groups absent, runner absent. All three child exits were0. The final manifest classified `pool_runtime_error`; the receipt reported its coarse `interrupted` outcome. The artifact did not retain event order or PostgreSQL error code, so it does not establish which event was first or why the pool emitted an error. [Sibling push CI35112499420](https://github.com/KnowScroll/knowscroll/actions/runs/35112499420) passed at the same head; neither run was an unchanged retry.

The inspected runner can overwrite failure classification in three places: the pool event callback, pause loop and catch priority. Its signal callback initially records only a boolean. A later pool event can therefore replace an earlier observed interruption. This source defect is separate from the older missing-acknowledgement failure; #57 remains open for that historical uncertainty.

No raw stderr, token or provider data is retained. Verification must keep expected primary classification, final cleanup acknowledgement, zero cleanup errors and independently absent database/runner/process groups. Fallback cleanup never turns a failed observation into passing evidence.
