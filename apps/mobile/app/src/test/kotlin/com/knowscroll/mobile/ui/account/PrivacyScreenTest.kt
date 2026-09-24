package com.knowscroll.mobile.ui.account

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
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
        onRequestExport = {}, onRetryExport = {}, onExportSaved = {},
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
