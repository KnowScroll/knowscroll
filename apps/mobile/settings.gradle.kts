/*
 * settings.gradle.kts — KnowScroll mobile
 *
 * The mobile slice is one Android application module. Repository name
 * is intentionally short; AGP requires settings.gradle(.kts) at the
 * module root, even for a single-module project.
 *
 * The plugin and dependency repositories are declared at the settings
 * level so the AGP plugin can resolve from the same configuration that
 * the runtime dependencies use. AGP 9.4.0 + Gradle 9.6.0 expect
 * repositories declared in pluginManagement {} so the Android and
 * Kotlin plugins are resolvable before the project is configured.
 */

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "knowscroll-mobile"

include(":app")