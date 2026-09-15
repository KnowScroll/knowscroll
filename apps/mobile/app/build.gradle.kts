import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}
val journeyBase = System.getenv("KS_JOURNEY_API_URL")
val local = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
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
    }
    buildFeatures { compose = true; buildConfig = true }
    buildTypes {
        debug {
            if (journeyBase != null) applicationIdSuffix = ".journey"
            buildConfigField("String", "KS_DEV_TOKEN", quoted(local.getProperty("KS_DEV_TOKEN", System.getenv("KS_DEV_TOKEN") ?: "")))
            buildConfigField("String", "KS_DEBUG_API_BASE", quoted(journeyBase ?: local.getProperty("KS_DEBUG_API_BASE", "http://10.0.2.2:4310")))
        }
        release {
            buildConfigField("String", "KS_DEV_TOKEN", quoted(""))
            buildConfigField("String", "KS_DEBUG_API_BASE", quoted(""))
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
androidComponents { beforeVariants(selector().withBuildType("release")) { it.enable = false } }
dependencies {
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
    androidTestImplementation(bom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
