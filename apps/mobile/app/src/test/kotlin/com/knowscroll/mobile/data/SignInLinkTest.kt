package com.knowscroll.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #135 (ADR-0034 section 6): the pasted-link parser is pure, and rejects anything it cannot be
 * certain about rather than guessing. */
class SignInLinkTest {
    @Test
    fun readsTheFragmentTokenFromTheWebSignInLink() {
        assertEquals("abc123", parseSignInToken("https://knowscroll.example/sign-in#token=abc123"))
    }

    @Test
    fun readsTheQueryTokenFromTheApisOwnConfirmLink() {
        assertEquals("abc123", parseSignInToken("http://127.0.0.1:4310/v1/auth/confirm?token=abc123"))
    }

    @Test
    fun prefersTheFragmentWhenBothAreSomehowPresent() {
        assertEquals("frag", parseSignInToken("https://knowscroll.example/sign-in?token=query#token=frag"))
    }

    @Test
    fun decodesAPercentEncodedToken() {
        assertEquals("abc/123+x", parseSignInToken("https://knowscroll.example/sign-in#token=abc%2F123%2Bx"))
    }

    @Test
    fun ignoresOtherParametersAroundTheToken() {
        assertEquals("abc123", parseSignInToken("https://knowscroll.example/sign-in?foo=1&token=abc123&bar=2"))
    }

    @Test
    fun trimsSurroundingWhitespace() {
        assertEquals("abc123", parseSignInToken("  https://knowscroll.example/sign-in#token=abc123\n"))
    }

    @Test
    fun rejectsAnEmptyToken() {
        assertNull(parseSignInToken("https://knowscroll.example/sign-in#token="))
        assertNull(parseSignInToken("https://knowscroll.example/sign-in?token="))
    }

    @Test
    fun rejectsAMissingTokenParameter() {
        assertNull(parseSignInToken("https://knowscroll.example/sign-in?foo=bar"))
        assertNull(parseSignInToken("https://knowscroll.example/sign-in"))
    }

    @Test
    fun rejectsSomethingThatIsNotAUrlAtAll() {
        assertNull(parseSignInToken("abc123"))
        assertNull(parseSignInToken(""))
        assertNull(parseSignInToken("   "))
        assertNull(parseSignInToken("token=abc123"))
    }

    @Test
    fun rejectsAnUnrecognisedScheme() {
        assertNull(parseSignInToken("mailto:owner@knowscroll.example?token=abc123"))
        assertNull(parseSignInToken("ftp://knowscroll.example/sign-in?token=abc123"))
    }

    @Test
    fun rejectsAMalformedUri() {
        assertNull(parseSignInToken("https://knowscroll.example/sign-in#token=%zz"))
    }

    // ---- #168 (ADR-0047): a link opened as an App Link ----

    private val host = "links.knowscroll.example"

    @Test
    fun takesTheMailedLinkForThisAppsHost() {
        val link = "https://links.knowscroll.example/sign-in#token=abc123"
        assertEquals(link, receivedSignInLink(link, host, launchedFromHistory = false))
    }

    @Test
    fun takesTheHostWhateverItsCase() {
        val link = "https://Links.KnowScroll.example/sign-in#token=abc123"
        assertEquals(link, receivedSignInLink(link, host, launchedFromHistory = false))
    }

    /** Recents relaunches an activity with the intent that first started it: that link was already
     * taken once, and its token is spent or nearly expired. */
    @Test
    fun neverTakesALinkAgainFromARelaunchOutOfRecents() {
        assertNull(receivedSignInLink("https://links.knowscroll.example/sign-in#token=abc123", host, launchedFromHistory = true))
    }

    /** Any app can send the activity a link: only exactly this host, over https on its default port,
     * at /sign-in, with a token, is ever put in front of the reader. */
    @Test
    fun takesNothingButThatExactShape() {
        for (other in listOf(
            "https://elsewhere.example/sign-in#token=abc123",
            "https://links.knowscroll.example.evil.example/sign-in#token=abc123",
            "http://links.knowscroll.example/sign-in#token=abc123",
            "https://links.knowscroll.example:8443/sign-in#token=abc123",
            "https://someone@links.knowscroll.example/sign-in#token=abc123",
            "https://links.knowscroll.example/v1/auth/confirm?token=abc123",
            "https://links.knowscroll.example/sign-in/extra#token=abc123",
            "https://links.knowscroll.example/sign-in",
            "https://links.knowscroll.example/sign-in#token=",
            "not a link",
        )) assertNull(other, receivedSignInLink(other, host, launchedFromHistory = false))
        assertNull(receivedSignInLink(null, host, launchedFromHistory = false))
    }
}
