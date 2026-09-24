package com.knowscroll.mobile.ui.account

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** #135: the sign-in screen renders the right control for each state and reports the reader's
 * input back through its callbacks -- it makes no decision of its own (see AccountViewModelTest
 * for the actual sign-in flow). */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
class SignInScreenTest {
    @get:Rule val composeRule = createComposeRule()

    private fun render(
        linkRequest: LinkRequestState = LinkRequestState.Idle,
        tokenSubmit: TokenSubmitState = TokenSubmitState.Idle,
        reason: SignedOutReason? = null,
        onRequestLink: (String) -> Unit = {},
        onSubmitLink: (String) -> Unit = {},
        receivedLink: String? = null,
    ) {
        composeRule.setContent {
            KnowScrollTheme {
                SignInScreen(linkRequest, tokenSubmit, reason, onRequestLink, onSubmitLink, receivedLink)
            }
        }
    }

    /** #168 (ADR-0047): an opened App Link fills the field; signing in is still the reader's tap. */
    @Test
    fun anOpenedLinkFillsTheFieldAndSignsInOnlyOnTheReadersTap() {
        var submitted: String? = null
        render(onSubmitLink = { submitted = it }, receivedLink = "https://links.knowscroll.example/sign-in#token=abc")
        composeRule.onAllNodesWithText("https://links.knowscroll.example/sign-in#token=abc").assertCountEquals(1)
        assertEquals(null, submitted)
        composeRule.onNodeWithContentDescription("Sign in with this link").performClick()
        assertEquals("https://links.knowscroll.example/sign-in#token=abc", submitted)
    }

    @Test
    fun sendLinkIsDisabledUntilAnEmailIsTyped() {
        render()
        composeRule.onNodeWithContentDescription("Send sign-in link").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("Email").performTextInput("owner@knowscroll.test")
        composeRule.onNodeWithContentDescription("Send sign-in link").assertIsEnabled()
    }

    @Test
    fun tappingSendLinkReportsExactlyTheTypedEmail() {
        var requested: String? = null
        render(onRequestLink = { requested = it })
        composeRule.onNodeWithContentDescription("Email").performTextInput("owner@knowscroll.test")
        composeRule.onNodeWithContentDescription("Send sign-in link").performClick()
        assertEquals("owner@knowscroll.test", requested)
    }

    @Test
    fun theOneFixedMessageAppearsAfterALinkIsSent() {
        render(linkRequest = LinkRequestState.Sent)
        composeRule.onAllNodesWithText(
            "Check your email. If that address can sign in, a link is on its way. It works once and expires soon.",
        ).assertCountEquals(1)
    }

    @Test
    fun submitWithThisLinkIsDisabledUntilSomethingIsPasted() {
        render()
        composeRule.onNodeWithContentDescription("Sign in with this link").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("Paste your sign-in link").performTextInput("https://knowscroll.test/sign-in#token=abc")
        composeRule.onNodeWithContentDescription("Sign in with this link").assertIsEnabled()
    }

    @Test
    fun tappingSubmitReportsExactlyThePastedText() {
        var pasted: String? = null
        render(onSubmitLink = { pasted = it })
        composeRule.onNodeWithContentDescription("Paste your sign-in link").performTextInput("https://knowscroll.test/sign-in#token=abc")
        composeRule.onNodeWithContentDescription("Sign in with this link").performClick()
        assertEquals("https://knowscroll.test/sign-in#token=abc", pasted)
    }

    @Test
    fun anInvalidLinkMessageIsShownAndTheAccountDeletedReasonNeverIsAtTheSameTime() {
        render(tokenSubmit = TokenSubmitState.InvalidLink("That doesn't look like a KnowScroll sign-in link."))
        composeRule.onAllNodesWithText("That doesn't look like a KnowScroll sign-in link.").assertCountEquals(1)
    }

    @Test
    fun theAccountDeletedMessageAppearsForThatSpecificReason() {
        render(reason = SignedOutReason.ACCOUNT_DELETED)
        composeRule.onAllNodesWithText("Your account and history were deleted.").assertCountEquals(1)
    }

    /** An ordinary sign-out (the Privacy screen's, or the reader's own #91 "Sign out this device")
     * lands here, on a screen that can sign back in -- saying only that, never a deletion/expiry. */
    @Test
    fun anOrdinarySignOutSaysOnlyThatThisDeviceIsSignedOut() {
        render(reason = SignedOutReason.SIGNED_OUT)
        composeRule.onAllNodesWithText("This device is signed out").assertCountEquals(1)
        composeRule.onAllNodesWithText("Your account and history were deleted.").assertCountEquals(0)
        composeRule.onAllNodesWithText("Your session ended. Sign in again to continue.").assertCountEquals(0)
    }

    @Test
    fun aDeletionOrResetThatNeverLandedSaysSoAndNeverClaimsIt() {
        render(reason = SignedOutReason.SESSION_ENDED_BEFORE_DELETE)
        composeRule.onAllNodesWithText("Your session ended before the deletion was sent. Sign in and try again.").assertCountEquals(1)
        composeRule.onAllNodesWithText("Your account and history were deleted.").assertCountEquals(0)
    }

    @Test
    fun aResetThatNeverLandedSaysSo() {
        render(reason = SignedOutReason.SESSION_ENDED_BEFORE_RESET)
        composeRule.onAllNodesWithText("Your session ended before the reset was sent. Sign in and try again.").assertCountEquals(1)
        composeRule.onAllNodesWithText("Your personal history was reset. Sign in again to continue.").assertCountEquals(0)
    }
}
