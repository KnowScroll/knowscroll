# Keep generated BuildConfig fields — they are read by ApiClient.
-keep class com.knowscroll.mobile.BuildConfig { *; }

# Kotlin coroutines: keep continuation classes intact for suspend calls
# that may be inlined. Default R8 rules cover most of this in AGP 9.x.
-dontwarn kotlinx.coroutines.**

# AndroidX / Compose: default rules from AGP 9.x already cover these,
# but a release build for the bootstrap slice is not exercised.
-dontwarn androidx.compose.**
