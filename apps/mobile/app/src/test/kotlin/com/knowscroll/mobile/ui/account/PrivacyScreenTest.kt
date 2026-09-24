package com.knowscroll.mobile.ui.account

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.core.app.ActivityOptionsCompat
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** #135: which control the Privacy screen offers for each state -- every decision is
 * [AccountViewModel]'s (see `AccountViewModelTest`); this only checks the rendering. A hosting
 * activity is needed here (unlike `SignInScreenTest`'s bare `createComposeRule`) because the
 * export button's `rememberLauncherForActivityResult` needs a real `ActivityResultRegistryOwner`. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class PrivacyScreenTest {
    @get:Rule val composeRule = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    private fun noopActions() = PrivacyActions(
        onBack = {}, onRetryLoad = {},
        onRequestPause = {}, onRetryPause = {}, onRequestResume = {}, onRetryResume = {},
        onRequestExport = {}, onRetryExport = {}, onExportSaved = {}, onExportNotSaved = {},
        onRequestResetConfirmation = {}, onCancelReset = {}, onConfirmReset = {}, onRetryReset = {},
        onRequestDeleteConfirmation = {}, onCancelDelete = {}, onConfirmDelete = {}, onRetryDelete = {},
        onRequestSignOutConfirmation = {}, onCancelSignOut = {}, onConfirmSignOut = {}, onRetrySignOut = {},
    )

    private fun render(
        privacy: PrivacyState,
        pause: PrivacyOperationState = PrivacyOperationState.Idle,
        resume: PrivacyOperationState = PrivacyOperationState.Idle,
        export: ExportState = ExportState.Idle,
        reset: PrivacyOperationState = PrivacyOperationState.Idle,
        delete: PrivacyOperationState = PrivacyOperationState.Idle,
        signOut: PrivacyOperationState = PrivacyOperationState.Idle,
        actions: PrivacyActions = noopActions(),
    ) {
        composeRule.setContent {
            KnowScrollTheme {
                PrivacyScreen(privacy, pause, resume, export, reset, delete, signOut, actions)
            }
        }
    }

    /** A ready export whose save picker is answered in process with [chosen], standing in for the
     * system's document picker. */
    private fun renderSavingTo(chosen: Uri, json: String, actions: PrivacyActions) {
        val picker = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
                dispatchResult(requestCode, Activity.RESULT_OK, Intent().setData(chosen))
            }
        }
        composeRule.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides object : ActivityResultRegistryOwner {
                override val activityResultRegistry = picker
            }) {
                KnowScrollTheme {
                    PrivacyScreen(PrivacyState.Loaded("u1", null, 1), PrivacyOperationState.Idle, PrivacyOperationState.Idle,
                        ExportState.Ready(json), PrivacyOperationState.Idle, PrivacyOperationState.Idle, PrivacyOperationState.Idle, actions)
                }
            }
        }
    }

    /** #168: the file the reader chose holds the export before it is called saved. */
    @Test
    fun anExportWrittenToTheChosenFileIsReportedSaved() {
        val file = File.createTempFile("knowscroll-export", ".json").apply { deleteOnExit() }
        var saved = 0
        var notSaved = 0
        renderSavingTo(Uri.fromFile(file), """{"rowCounts":{}}""", noopActions().copy(onExportSaved = { saved++ }, onExportNotSaved = { notSaved++ }))
        composeRule.onNodeWithContentDescription("Save the export file").performClick()
        composeRule.waitForIdle()
        assertEquals(1, saved)
        assertEquals(0, notSaved)
        assertEquals("""{"rowCounts":{}}""", file.readText())
    }

    /** #168: a destination that refuses the write is reported, never taken for a saved export. */
    @Test
    fun anExportTheChosenFileRefusedIsReportedNotSaved() {
        var saved = 0
        var notSaved = 0
        renderSavingTo(Uri.parse("content://com.knowscroll.test.nowhere/export.json"), "{}",
            noopActions().copy(onExportSaved = { saved++ }, onExportNotSaved = { notSaved++ }))
        composeRule.onNodeWithContentDescription("Save the export file").performClick()
        composeRule.waitForIdle()
        assertEquals(0, saved)
        assertEquals(1, notSaved)
    }

    @Test
    fun activeRecordingOffersPauseNotResume() {
        render(PrivacyState.Loaded("u1", recordingPausedAt = null, privacyEpoch = 1))
        composeRule.onNodeWithContentDescription("Pause recording").assertHeightIsAtLeast(48.dp)
        composeRule.onAllNodesWithContentDescription("Resume recording").assertCountEquals(0)
        composeRule.onAllNodesWithText("Recording is on. Reading is written to your history as usual.").assertCountEquals(1)
    }

    @Test
    fun pausedRecordingOffersResumeAndNamesWhen() {
        render(PrivacyState.Loaded("u1", recordingPausedAt = "2026-09-24T00:00:00Z", privacyEpoch = 1))
        composeRule.onNodeWithContentDescription("Resume recording").assertHeightIsAtLeast(48.dp)
        composeRule.onAllNodesWithContentDescription("Pause recording").assertCountEquals(0)
        composeRule.onAllNodesWithText("Recording is paused since 2026-09-24T00:00:00Z. Nothing new is written to your history.").assertCountEquals(1)
    }

    @Test
    fun readyExportOffersTheSaveButton() {
        render(PrivacyState.Loaded("u1", null, 1), export = ExportState.Ready("{}"))
        composeRule.onNodeWithContentDescription("Save the export file").assertHeightIsAtLeast(48.dp)
    }

    @Test
    fun resetConfirmationNamesItsOwnEffectsAndBothButtonsAreReachable() {
        var confirmed = false
        render(PrivacyState.Loaded("u1", null, 1), reset = PrivacyOperationState.Confirming, actions = noopActions().copy(onConfirmReset = { confirmed = true }))
        composeRule.onAllNodesWithText("Reset your personal history?").assertCountEquals(1)
        composeRule.onNodeWithContentDescription("Confirm reset my personal history").performClick()
        assertTrue(confirmed)
    }

    @Test
    fun deleteConfirmationHasItsOwnLiteralDistinctFromReset() {
        render(PrivacyState.Loaded("u1", null, 1), delete = PrivacyOperationState.Confirming)
        composeRule.onAllNodesWithText("Delete your account and history?").assertCountEquals(1)
        composeRule.onNodeWithContentDescription("Confirm delete my account").assertHeightIsAtLeast(48.dp)
        composeRule.onNodeWithContentDescription("Cancel delete my account").assertHeightIsAtLeast(48.dp)
    }

    @Test
    fun aFailedOperationOffersAnExplicitRetryWithTheMessage() {
        render(PrivacyState.Loaded("u1", null, 1), pause = PrivacyOperationState.Failed("Connection interrupted. Please retry."))
        composeRule.onAllNodesWithText("Connection interrupted. Please retry.").assertCountEquals(1)
        composeRule.onNodeWithContentDescription("Retry pause recording").assertHeightIsAtLeast(48.dp)
    }

    @Test
    fun loadingShowsNeitherRecordingNorDestructiveControls() {
        render(PrivacyState.Loading)
        composeRule.onAllNodesWithContentDescription("Pause recording").assertCountEquals(0)
        composeRule.onAllNodesWithContentDescription("Delete my account").assertCountEquals(0)
    }
}
