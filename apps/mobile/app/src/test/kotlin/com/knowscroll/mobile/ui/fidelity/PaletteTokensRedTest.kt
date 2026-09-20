package com.knowscroll.mobile.ui.fidelity

import androidx.compose.ui.graphics.Color
import com.knowscroll.mobile.ui.theme.Cosmos
import kotlin.reflect.KProperty1
import kotlin.reflect.full.memberProperties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * RED against the current, unmodified theme (#111). docs/product/ui-system.md section 1 names
 * the whole Cosmos palette verbatim, including five tokens `Cosmos` (Theme.kt) does not define
 * today: deep, sea, sea-2, teal-2 and green. A sixth — the raised-panel colour that Living
 * Observatory's `--space-2` names ("raised ground, panels behind content") — exists only as a
 * stray inline `Color(0xFF0A1B26)` literal in UniverseScreen.kt and in Theme.kt's `surfaceVariant`,
 * never as a named theme token.
 *
 * These tests read the compiled `Cosmos` object through Kotlin reflection instead of referencing
 * `Cosmos.Deep` etc. directly. A direct reference would fail to *compile* today, which would take
 * down every other test in this module (and the whole `testDebugUnitTest` task) rather than
 * failing on its own with an evidenced message — exactly the kind of all-or-nothing signal this
 * issue exists to replace.
 */
class PaletteTokensRedTest {
    private val properties: Map<String, KProperty1<Cosmos, *>> by lazy {
        Cosmos::class.memberProperties.associateBy { it.name }
    }

    private fun colorToken(name: String): Color? {
        val property = properties[name] ?: return null
        val value = property.get(Cosmos)
        return value as? Color
    }

    @Test
    fun `deep token exists at the spec value`() {
        val value = colorToken("Deep")
        assertNotNull(
            "Cosmos has no 'Deep' token yet (--deep #0b2b33, 'card and stage fill' per " +
                "ui-system.md section 1). Properties found on Cosmos: ${properties.keys.sorted()}",
            value
        )
        assertEquals(Color(0xFF0B2B33), value)
    }

    @Test
    fun `sea token exists at the spec value`() {
        val value = colorToken("Sea")
        assertNotNull(
            "Cosmos has no 'Sea' token yet (--sea #17505f, 'rails, borders, quiet fills'). " +
                "Properties found on Cosmos: ${properties.keys.sorted()}",
            value
        )
        assertEquals(Color(0xFF17505F), value)
    }

    @Test
    fun `sea-2 token exists at the spec value`() {
        val value = colorToken("Sea2")
        assertNotNull(
            "Cosmos has no 'Sea2' token yet (--sea-2 #0f3644). " +
                "Properties found on Cosmos: ${properties.keys.sorted()}",
            value
        )
        assertEquals(Color(0xFF0F3644), value)
    }

    @Test
    fun `teal-2 token exists at the spec value`() {
        val value = colorToken("Teal2")
        assertNotNull(
            "Cosmos has no 'Teal2' token yet (--teal-2 #8fe9e4). " +
                "Properties found on Cosmos: ${properties.keys.sorted()}",
            value
        )
        assertEquals(Color(0xFF8FE9E4), value)
    }

    @Test
    fun `green token exists at the spec value`() {
        val value = colorToken("Green")
        assertNotNull(
            "Cosmos has no 'Green' token yet (--green #64d47d, 'verified / checked-out states'). " +
                "Properties found on Cosmos: ${properties.keys.sorted()}",
            value
        )
        assertEquals(Color(0xFF64D47D), value)
    }

    @Test
    fun `raised panel token exists at the spec value`() {
        val value = colorToken("SpaceRaised")
        assertNotNull(
            "Cosmos has no named raised-panel token yet (--space-2 #061a27, 'raised ground, " +
                "panels behind content'). UniverseScreen.kt and Theme.kt's surfaceVariant both " +
                "fill this role with a stray inline Color(0xFF0A1B26) instead -- a different " +
                "value from the spec, and not a named token either way. " +
                "Properties found on Cosmos: ${properties.keys.sorted()}",
            value
        )
        assertEquals(Color(0xFF061A27), value)
    }
}
