# #168 (ADR-0047): release builds are shrunk and obfuscated by R8. The app itself uses no reflection.
# What is created reflectively is kept by its own library's consumer rules: ViewModels built by the
# default factory (androidx.lifecycle keeps their (), (Application) and (Application,
# SavedStateHandle) constructors), the coroutines main dispatcher's service loader
# (kotlinx-coroutines-android) and Media3. AAPT keeps the manifest's Application and Activity.

# Keep generated BuildConfig fields -- they are read by ApiClient and MainActivity.
-keep class com.knowscroll.mobile.BuildConfig { *; }
