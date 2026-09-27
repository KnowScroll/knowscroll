package com.knowscroll.mobile.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import org.junit.Assert.assertTrue

private val SOURCE_WORDING = Regex("""\bsource""", RegexOption.IGNORE_CASE)

/** "Source", "sources", "sourced", "Source-backed": wording that points the reader at a source. */
internal fun pointsAtASource(text: String): Boolean = SOURCE_WORDING.containsMatchIn(text)

/**
 * #161: readers never see a source. Everything on screen -- each node's text and what TalkBack
 * reads for it -- is checked for the fixture's own source names and addresses, and for any wording
 * that points at a source at all.
 */
internal fun SemanticsNodeInteractionsProvider.assertNoSourceShown(vararg sources: String) {
    val shown = onAllNodes(SemanticsMatcher("any node") { true }, useUnmergedTree = true).fetchSemanticsNodes().flatMap { node ->
        with(node.config) {
            getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
                listOfNotNull(getOrNull(SemanticsProperties.EditableText)?.text) +
                getOrNull(SemanticsProperties.ContentDescription).orEmpty() +
                listOfNotNull(getOrNull(SemanticsProperties.StateDescription))
        }
    }
    assertTrue("nothing was rendered to check", shown.isNotEmpty())
    val leaks = shown.filter { text -> pointsAtASource(text) || sources.any { it in text } }
    assertTrue("a source is shown to the reader: $leaks", leaks.isEmpty())
}
