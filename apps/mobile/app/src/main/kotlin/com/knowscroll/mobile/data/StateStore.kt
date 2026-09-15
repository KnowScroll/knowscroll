package com.knowscroll.mobile.data

import android.content.Context
import org.json.JSONObject
import java.util.UUID

data class ScrollSession(
    val decisionId: String, val item: ScrollItem,
    val clientExposureId: String = UUID.randomUUID().toString(),
    val clientEventId: String = UUID.randomUUID().toString(),
    val exposureId: String = "", val exposureEventId: String = "",
    val keepJobId: String = "", val keepEventId: String = ""
)

/** Persist the whole retry envelope together, not a UUID detached from its payload. */
class StateStore(context: Context) {
    private val prefs = context.getSharedPreferences("ks_session_v1", Context.MODE_PRIVATE)
    fun write(s: ScrollSession) {
        val item = JSONObject().apply {
            put("assetId", s.item.assetId); put("revision", s.item.revision); put("kind", s.item.kind)
            put("title", s.item.title); put("summary", s.item.summary); put("body", s.item.body)
            put("sourceTitle", s.item.sourceTitle); put("sourceUrl", s.item.sourceUrl)
            put("truthState", s.item.truthState); put("reason", s.item.reason)
        }
        val json = JSONObject().apply {
            put("decisionId", s.decisionId); put("item", item)
            put("clientExposureId", s.clientExposureId); put("clientEventId", s.clientEventId)
            put("exposureId", s.exposureId); put("exposureEventId", s.exposureEventId)
            put("keepJobId", s.keepJobId); put("keepEventId", s.keepEventId)
        }
        check(prefs.edit().putString("session", json.toString()).commit()) { "Could not save the retry envelope" }
    }
    fun read(): ScrollSession? {
        val raw = prefs.getString("session", null) ?: return null
        val o = JSONObject(raw); val i = o.getJSONObject("item")
        val item = ScrollItem(i.getString("assetId"),i.getInt("revision"),i.getString("kind"),i.getString("title"),i.getString("summary"),i.getString("body"),i.getString("sourceTitle"),i.getString("sourceUrl"),i.getString("truthState"),i.getString("reason"))
        return ScrollSession(o.getString("decisionId"),item,o.getString("clientExposureId"),o.getString("clientEventId"),o.getString("exposureId"),o.getString("exposureEventId"),o.getString("keepJobId"),o.getString("keepEventId"))
    }
}
