package com.knowscroll.mobile.ui.keep

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.Before
import org.junit.After
import java.util.Locale
import java.util.TimeZone

/**
 * Audit A4 (#72): the Keep list must show a human-readable date, not the raw ISO timestamp.
 * Pure unit coverage so the formatter's behaviour is locked independently of any Compose
 * dependency: every common ISO 8601 shape the API can send is converted, anything we do not
 * recognise falls back to the original string verbatim rather than inventing a date, and the
 * output is never the ISO timestamp itself (which was the audit's specific defect).
 */
class KeepDateFormattingTest {
    private val originalLocale = Locale.getDefault()
    private val originalZone = TimeZone.getDefault()
    @Before fun deterministicLocale() { Locale.setDefault(Locale.US); TimeZone.setDefault(TimeZone.getTimeZone("UTC")) }
    @After fun restoreLocale() { Locale.setDefault(originalLocale); TimeZone.setDefault(originalZone) }


    @Test
    fun `millisecond UTC timestamp becomes a localized date`() {
        // ISO 8601 with milliseconds and Z, as the canonical returned shape.
        assertEquals("Aug 20, 2026", humanDate("2026-08-20T00:00:00.000Z"))
    }

    @Test
    fun `second-precision UTC timestamp is also parsed`() {
        assertEquals("Aug 20, 2026", humanDate("2026-08-20T00:00:00Z"))
    }

    @Test
    fun `offset timestamp is also parsed and the visible date is never the raw ISO string`() {
        // The audit forbids the card showing the raw ISO timestamp (the defect). Pinning the
        // visible date in absolute terms is brittle to the JVM's default timezone, so instead
        // we pin the two structural claims: the offset is recognised (so the formatted output
        // is a date, not the raw string), and the result differs from the input. The exact
        // wall-clock day is whatever the device's local zone resolves it to -- the device's
        // job, not the formatter's.
        val raw = "2026-08-20T00:00:00.000+02:00"
        val formatted = humanDate(raw)
        assertEquals("Aug 19, 2026", formatted)
        // Year survives every reasonable timezone: 2026 is unambiguous.
        assertEquals(true, formatted.contains("2026"))
        // Month-day component is present in "MMM d" form (e.g. "Aug 20"), not "2026-08-20".
        assertEquals(false, formatted.contains("2026-08-20"))
    }

    @Test
    fun `an unrecognised string is returned verbatim rather than inventing a date`() {
        // The audit forbids the client fabricating date information; the honest fallback is the
        // original ISO string the API gave us, not a guessed date.
        val raw = "not-a-date-shape"
        assertEquals(raw, humanDate(raw))
    }

    @Test
    fun `formatted output is never the original ISO timestamp`() {
        // The audit's specific defect was that the card displayed the raw ISO string. Pinning
        // this assertion catches any future regression that accidentally bypasses the formatter.
        val raw = "2026-08-20T00:00:00.000Z"
        assertNotEquals(raw, humanDate(raw))
    }
}
