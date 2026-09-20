package com.knowscroll.mobile.ui.theme

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * docs/product/ui-system.md section 5: "Each [truth] state has one pill, always adjacent to the
 * claim it qualifies... A compelling presentation may never upgrade a weak claim, so the pill is
 * drawn with equal weight regardless of state" — which requires the seven states to actually be
 * visually distinguishable, not just differently worded.
 *
 * No reference or definition.md section enumerates a colour per truth state (checked: definition.md
 * section 12 gives meanings, not colours). The seven tints below reuse only Cosmos palette tokens —
 * no new hex value is invented — and match the mapping already shipped on desktop
 * (apps/web/src/styles.css `.truth-pill.state-*`), so the two surfaces agree rather than each
 * guessing independently. This is a deviation worth recording precisely because it is invented
 * structure, not extracted verbatim like the rest of this file.
 */
private data class TruthTint(val background: Color, val foreground: Color)

private fun truthTint(truthState: String): TruthTint = when (truthState) {
    "documented" -> TruthTint(Cosmos.Green, Cosmos.InkOnCream)
    "synthesis" -> TruthTint(Cosmos.Teal, Cosmos.InkOnCream)
    "interpretation" -> TruthTint(Cosmos.Sea, Cosmos.Cream)
    "disputed" -> TruthTint(Cosmos.Coral, Cosmos.InkOnCream)
    "modelled" -> TruthTint(Cosmos.Teal2, Cosmos.InkOnCream)
    "counterfactual" -> TruthTint(Cosmos.Pink, Cosmos.InkOnCream)
    "fictional" -> TruthTint(Cosmos.Yellow, Cosmos.InkOnCream)
    else -> TruthTint(Cosmos.Sea2, Cosmos.Cream)
}

/**
 * A truth-state pill: docs/product/ui-system.md sections 2 (micro-labels: monospace, 10px,
 * uppercase, weight 700, letter-spacing .08em — "these carry truth state") and 3 ("Truth and state
 * pills: monospace 10px, border-radius:999px, 3px 8px, tinted per state").
 *
 * [label] is the exact string already shown today (e.g. "SCROLL · DOCUMENTED") so existing journeys
 * that search for that text keep finding it; the pill adds colour and a machine-readable
 * `contentDescription` ("Truth state: <truthState>") without replacing or hiding that text.
 */
@Composable
fun TruthPill(truthState: String, label: String, modifier: Modifier = Modifier) {
    val tint = truthTint(truthState)
    Surface(
        color = tint.background,
        contentColor = tint.foreground,
        shape = RoundedCornerShape(percent = 50),
        modifier = modifier.semantics { contentDescription = "Truth state: $truthState" }
    ) {
        Text(
            label,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            fontSize = 10.sp,
            letterSpacing = 0.8.sp,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
        )
    }
}
