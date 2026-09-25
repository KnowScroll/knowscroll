import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("io.github.takahirom.roborazzi")
}
val journeyBase = System.getenv("KS_JOURNEY_API_URL")
// #136: device test runners build their own app (".journeytest") so they never replace the owner's
// running preview (".journey", built by scripts/android-living-preview.py, which sets no suffix).
val journeySuffix = (System.getenv("KS_APP_ID_SUFFIX") ?: ".journey").also {
    require(journeyBase == null || Regex("^\\.journey[a-z]*$").matches(it)) { "KS_APP_ID_SUFFIX must be .journey or .journey<letters>" }
}
val local = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
// #168 (ADR-0047): App Links answer only for the owner's domain, which arrives at release time.
// `.invalid` never resolves (RFC 6761), so until then nothing can be verified.
val appLinksPlaceholder = "links.knowscroll.invalid"
// #168 (ADR-0047): what only the owner can give a release build, never in Git. Each value comes from
// the environment, otherwise from the ignored release.properties (see release.properties.template
// and docs/operations/release-inputs.md). Debug builds read none of it.
val releaseFile = Properties().apply {
    rootProject.file("release.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun releaseInput(name: String): String? = (System.getenv(name) ?: releaseFile.getProperty(name))?.trim()?.takeIf { it.isNotEmpty() }
val releaseStoreFile = releaseInput("KS_RELEASE_STORE_FILE")?.let(::file)
val releaseApiBase = releaseInput("KS_RELEASE_API_BASE")
val releaseAppLinksHost = releaseInput("KS_APP_LINKS_HOST")
// Everything a release build still lacks, named in its refusal. There is no default production API:
// release traffic is https only (the main manifest allows no cleartext).
val missingReleaseInputs = buildList {
    if (releaseStoreFile?.isFile != true) add("KS_RELEASE_STORE_FILE (an existing keystore file)")
    listOf("KS_RELEASE_STORE_PASSWORD", "KS_RELEASE_KEY_ALIAS", "KS_RELEASE_KEY_PASSWORD").filterTo(this) { releaseInput(it) == null }
    val api = releaseApiBase?.let { runCatching { URI(it) }.getOrNull() }
    if (api?.scheme != "https" || api?.host.isNullOrEmpty()) add("KS_RELEASE_API_BASE (an https:// URL)")
    if (releaseAppLinksHost != null && !Regex("^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$").matches(releaseAppLinksHost)) {
        add("KS_APP_LINKS_HOST (a host name only, or unset)")
    }
}
android {
    namespace = "com.knowscroll.mobile"
    compileSdk { version = release(37) { minorApiLevel = 2 } }
    defaultConfig {
        applicationId = "com.knowscroll.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-bootstrap"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "KS_APP_LINKS_HOST", quoted(appLinksPlaceholder))
        manifestPlaceholders["appLinksHost"] = appLinksPlaceholder
    }
    buildFeatures { compose = true; buildConfig = true }
    signingConfigs {
        create("release") {
            storeFile = releaseStoreFile
            storePassword = releaseInput("KS_RELEASE_STORE_PASSWORD")
            keyAlias = releaseInput("KS_RELEASE_KEY_ALIAS")
            keyPassword = releaseInput("KS_RELEASE_KEY_PASSWORD")
        }
    }
    buildTypes {
        debug {
            if (journeyBase != null) applicationIdSuffix = journeySuffix
            val debugToken = if (journeyBase != null) System.getenv("KS_DEV_TOKEN") ?: ""
                else local.getProperty("KS_DEV_TOKEN", System.getenv("KS_DEV_TOKEN") ?: "")
            buildConfigField("String", "KS_DEV_TOKEN", quoted(debugToken))
            buildConfigField("String", "KS_API_BASE", quoted(journeyBase ?: local.getProperty("KS_DEBUG_API_BASE", "http://10.0.2.2:4310")))
        }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "KS_DEV_TOKEN", quoted(""))
            buildConfigField("String", "KS_API_BASE", quoted(releaseApiBase ?: ""))
            val appLinksHost = releaseAppLinksHost ?: appLinksPlaceholder
            buildConfigField("String", "KS_APP_LINKS_HOST", quoted(appLinksHost))
            manifestPlaceholders["appLinksHost"] = appLinksHost
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}
// #168 (ADR-0047): a release build refuses before it builds anything, naming each missing input,
// rather than failing later on a half-configured signing step or shipping without an API.
val checkReleaseInputs = tasks.register("checkReleaseInputs") {
    description = "Refuses a release build that lacks an owner input (ADR-0047)."
    val missing = missingReleaseInputs
    doLast {
        if (missing.isNotEmpty()) throw GradleException(
            "Release build refused. Missing or invalid: ${missing.joinToString("; ")}. Set each as an " +
                "environment variable or in apps/mobile/release.properties (ignored by Git; see " +
                "release.properties.template and docs/operations/release-inputs.md). Debug builds need none of them."
        )
    }
}
tasks.named { it == "preReleaseBuild" || it == "validateSigningRelease" }.configureEach { dependsOn(checkReleaseInputs) }
dependencies {
    implementation("androidx.media3:media3-exoplayer:1.9.3")
    implementation("androidx.media3:media3-ui:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-savedstate:2.9.4")
    val bom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-reflect:2.2.10")
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.74.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.74.0")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.test:core:1.6.1")
    androidTestImplementation(bom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
