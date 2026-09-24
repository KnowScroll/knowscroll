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
}
