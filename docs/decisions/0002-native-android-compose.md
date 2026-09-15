# ADR-0002 — Native Kotlin and Compose for Android first

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

KnowScroll depends on gestures, a custom cosmic canvas, Reel playback, Android lifecycle, local state and eventual synchronization. Android is the funded first client. No choice makes a polished iOS version essentially free.

## Decision

Use Kotlin + Jetpack Compose. Use Media3 for the future Reel renderer, Android persistence and background APIs as those features land. Initial compatibility set: AGP 9.4.0, Gradle 9.6.0, built-in Kotlin 2.2.10 with matching Compose compiler plugin, Compose BOM 2026.09.00, JDK17, compile SDK37.2, target SDK36 and minimum SDK26. SDK36 is a conservative initial emulator target; review Play target requirements before release.

## Alternatives and why

| Option | Fit and trade-off for KnowScroll |
|---|---|
| Native Kotlin/Compose | Direct canvas, input, media and lifecycle APIs; selected for Android focus. New Kotlin skills are required. |
| Kotlin Multiplatform | Can share logic later, but adds targets/build concerns now; defer until another real client needs it. |
| React Native | Modern native-module/rendering architecture is capable. TypeScript reuse helps, but our richest interactions still need native expertise and cross-runtime debugging. |
| Expo | Development builds and native modules are real options; it is not limited to Expo Go. Tooling simplifies RN delivery, but provides less advantage for an Android-specific custom surface. |
| Flutter | Its renderer is attractive for custom graphics. Dart and platform/plugin integration add another stack for media/system features. |

Native is the best fit under these constraints, not a claim that alternatives are too slow.

## Consequences

No iOS target or shared UI runtime now. Benchmark actual frame timing, video memory, gestures and low-end devices before performance claims. Model Room/DataStore/WorkManager, deep links and push as Android concerns in #3, not hidden capabilities of this skeleton. Bundled AGP POM and Compose Maven metadata verified the Kotlin/BOM pins; AGP release notes supply the Gradle/JDK/build-tools compatibility.

## Sources and verification

[Compose](https://developer.android.com/compose), [Media3](https://developer.android.com/media/media3/exoplayer), [offline-first guidance](https://developer.android.com/topic/architecture/data-layer/offline-first), [AGP9.4](https://developer.android.com/build/releases/agp-9-4-0-release-notes), [built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin), [KMP](https://kotlinlang.org/docs/multiplatform/native-and-cross-platform.html), [React Native](https://reactnative.dev/architecture/overview), [Expo](https://docs.expo.dev/workflow/overview/), [Flutter](https://docs.flutter.dev/resources/architectural-overview).

## Bootstrap validation adjustment

The first actual build rejected compile SDK36 because Compose 2026.09.00 libraries require at least API37. The compile SDK was raised to installed stable 37.2; target36 and minimum26 remain unchanged. This is a verified build constraint, not a reason to raise the minimum device version.
