# Android emulator journeys

The optional [native workflow](../../../.github/workflows/native.yml) builds on a hosted runner
and runs [run-ci.sh](run-ci.sh) against an Android emulator. It is separate from the six required
checks. The `run-native` PR label or an explicit workflow dispatch selects it; reading this guide
does not run a build or deploy a world.

With the lane's loopback test origin, [test-api/serve.mjs](test-api/serve.mjs) starts built API and
worker trees over disposable PostgreSQL, fixture media and a fixture mail file. The three journey
flows request a link, sign in and explore, then restart to check persistence. A configured HTTPS
origin instead runs the signed-out flows. Fixture content and emulator screenshots are never
real provider or physical-device evidence.

The other YAML flows check shell navigation, Back, galleries, Scroll blocks and Universe views.
The debug-signed build has no production signing authority. Keep the test-API flag and Android
cleartext checks together so a fixture network exception cannot enter an ordinary build. Follow
[the lane guide](../../../docs/v2/engineering/native-lane.md) for the exact inputs and recovery.
