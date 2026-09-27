package com.knowscroll.mobile

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

/**
 * #168 (ADR-0047): nothing this app stores -- the private reading state and its retry envelopes
 * (`ks_session_v1`), the sealed session (`ks_session_vault_v1`) -- leaves the device through a cloud
 * backup or a device-to-device transfer. Every storage domain is excluded whole, for both, so a
 * renamed or new file cannot slip past a rule that names files one by one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BackupRulesTest {
    @Test
    fun everyDomainIsExcludedWholeFromCloudBackupAndDeviceTransfer() {
        val parser = ApplicationProvider.getApplicationContext<Context>().resources.getXml(R.xml.data_extraction_rules)
        val excluded = mutableMapOf<String, MutableSet<String>>()
        var section: String? = null
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType != XmlPullParser.START_TAG) continue
            when (parser.name) {
                "cloud-backup", "device-transfer" -> section = parser.name
                "exclude" -> if (parser.getAttributeValue(null, "path") == ".") {
                    excluded.getOrPut(requireNotNull(section)) { mutableSetOf() } += parser.getAttributeValue(null, "domain")
                }
            }
        }
        val everyDomain = setOf("root", "file", "database", "sharedpref", "external")
        assertEquals(mapOf("cloud-backup" to everyDomain, "device-transfer" to everyDomain), excluded)
    }
}
