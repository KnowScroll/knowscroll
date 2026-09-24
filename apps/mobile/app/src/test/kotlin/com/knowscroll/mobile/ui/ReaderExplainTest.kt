package com.knowscroll.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure content-selection coverage for "Why this appeared" (#91). Every branch here
 * must be traceable to a field the API actually returned; nothing here may invent an
 * interest, a profile or an evidence path (Law 4, Law 11, Law 13). */
class ReaderExplainTest {

    @Test fun blankOrMissingReasonReportsNoRecordedExplanationInsteadOfGuessing() {
        assertNull(explainReasonText(""))
        assertNull(explainReasonText("   "))
    }

    @Test fun aNonBlankReasonIsReturnedVerbatimNeverRewritten() {
        val reason = "An editorial starting encounter. No interests have been inferred."
        assertEquals(reason, explainReasonText(reason))
        assertEquals("Trimmed but not rewritten", explainReasonText("  Trimmed but not rewritten  "))
    }

    @Test fun everyDefinedTruthStateHasAFixedMeaningFromSection12() {
        assertEquals("Directly supported by strong cited evidence.", truthStateMeaning("documented"))
        assertEquals("An evidence-grounded explanation produced by the system.", truthStateMeaning("synthesis"))
        assertEquals("A reasoned perspective rather than settled fact.", truthStateMeaning("interpretation"))
        assertEquals("Credible evidence materially disagrees.", truthStateMeaning("disputed"))
        assertEquals("Produced by an explicit simulation or causal model.", truthStateMeaning("modelled"))
        assertEquals("Explores a world that did not occur.", truthStateMeaning("counterfactual"))
        assertEquals("Invented for narrative or play.", truthStateMeaning("fictional"))
    }

    @Test fun anUnrecognizedTruthStateHasNoInventedMeaning() {
        assertNull(truthStateMeaning("not-a-real-state"))
    }

    @Test fun discoveryOriginNeverClaimsAnInterestOrSavedTrace() {
        val text = explainOriginText(ReaderOrigin.Discovery)
        assertTrue(text.contains("deliberate discovery"))
        assertFalse(text.contains("interest", ignoreCase = true))
        assertFalse(text.contains("kept", ignoreCase = true))
    }

    /** #161: no meaning or origin points the reader at a source. */
    @Test fun noMeaningOrOriginPointsAtASource() {
        val states = listOf("documented", "synthesis", "interpretation", "disputed", "modelled", "counterfactual", "fictional")
        val origins = listOf(ReaderOrigin.Discovery, ReaderOrigin.SavedTrace("event-a", "2026-09-17T00:00:00.000Z"),
            ReaderOrigin.Branch("Gravity pulls", "Gravity explains Tides", recorded = false))
        val copy = states.mapNotNull(::truthStateMeaning) + origins.map(::explainOriginText)
        assertEquals(emptyList<String>(), copy.filter(::pointsAtASource))
    }

    @Test fun savedTraceOriginStatesOnlyTheKeptDateTheApiReturned() {
        val text = explainOriginText(ReaderOrigin.SavedTrace("event-a", "2026-09-17T00:00:00.000Z"))
        assertTrue(text.contains("2026-09-17T00:00:00.000Z"))
        assertFalse(text.contains("interest", ignoreCase = true))
    }
}
