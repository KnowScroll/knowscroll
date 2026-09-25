package com.knowscroll.mobile.ui.account

import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #168: whether an export actually reached the file the reader chose -- never assumed. */
class ExportFileTest {
    @Test
    fun writesTheExportAsUtf8AndSaysSo() {
        val out = ByteArrayOutputStream()
        assertTrue(writeExport("""{"title":"Überall"}""") { out })
        assertArrayEquals("""{"title":"Überall"}""".toByteArray(Charsets.UTF_8), out.toByteArray())
    }

    /** The process died while the picker was open: the export, held only in memory, went with it. */
    @Test
    fun anExportLostWithTheProcessIsNotSavedAndTheFileIsNotOpened() {
        var opened = false
        assertFalse(writeExport(null) { opened = true; ByteArrayOutputStream() })
        assertFalse(opened)
    }

    @Test
    fun aDestinationThatCannotBeOpenedIsNotSaved() {
        assertFalse(writeExport("{}") { null })
        assertFalse(writeExport("{}") { throw FileNotFoundException("gone") })
    }

    @Test
    fun aWriteThatFailsIsNotSaved() {
        val failing = object : OutputStream() {
            override fun write(b: Int) = throw IOException("disk full")
        }
        assertFalse(writeExport("{}") { failing })
    }
}
