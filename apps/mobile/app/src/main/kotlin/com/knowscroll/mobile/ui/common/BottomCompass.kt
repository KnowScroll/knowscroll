package com.knowscroll.mobile.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.knowscroll.mobile.R
import com.knowscroll.mobile.ui.theme.Cosmos

/** Which section the bottom compass currently marks as active. */
enum class CompassTab { Atlas, Cable, Keep }

/** Shared Cable / Atlas / Keep order. Nested System and World screens belong to Atlas.
 * The dock reserves its own layout space so it never covers content or actions. */
@Composable
fun BottomCompass(
    selected: CompassTab?,
    onSelectAtlas: () -> Unit,
    onSelectCable: () -> Unit,
    onSelectKeep: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier.fillMaxWidth().padding(bottom = 25.dp), contentAlignment = Alignment.Center) {
        // docs/product/ui-system.md section 5b's dock recipe: `rgba(6,26,39,.78)` translucent fill,
        // a hairline `rgba(255,255,255,.12)` border. Deviation: the reference's own
        // `backdrop-filter: blur(12px)` (blurring whatever sits behind the dock) is not
        // implemented -- that needs API 31+ RenderEffect plumbing this app does not have -- so
        // only the translucency, border and shadow are real; nothing here fakes the blur.
        Surface(
            color = Cosmos.SpaceRaised.copy(alpha = 0.78f),
            contentColor = Cosmos.InkOnDark,
            shape = RoundedCornerShape(22.dp),
            border = BorderStroke(1.dp, Color.White.copy(alpha = 0.12f)),
            shadowElevation = 10.dp
        ) {
            Row(Modifier.padding(6.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                // Audit D3 (#72): shared dock order is Cable / Atlas / Keep on every level --
                // Cable (read) first, Atlas (universe) middle, Keep (Traces) last -- matching
                // the brief's wording and the audit's reading.
                CompassEntry(
                    glyph = "~",
                    label = stringResource(R.string.compass_cable),
                    selected = selected == CompassTab.Cable,
                    onClick = onSelectCable
                )
                CompassEntry(
                    glyph = "◎",
                    label = stringResource(R.string.compass_atlas),
                    selected = selected == CompassTab.Atlas,
                    onClick = onSelectAtlas
                )
                CompassEntry(
                    glyph = "▱",
                    label = stringResource(R.string.compass_keep),
                    selected = selected == CompassTab.Keep,
                    onClick = onSelectKeep
                )
            }
        }
    }
}

@Composable
private fun CompassEntry(glyph: String, label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) Color.White.copy(alpha = 0.14f) else Color.Transparent,
        contentColor = if (selected) Cosmos.InkOnDark else Cosmos.InkOnDark.copy(alpha = 0.7f),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier
            .heightIn(min = 48.dp)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
    ) {
        Column(
            modifier = Modifier.padding(PaddingValues(horizontal = 18.dp, vertical = 8.dp)),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(glyph, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(label, fontSize = 10.5.sp, fontWeight = FontWeight(700))
        }
    }
}
