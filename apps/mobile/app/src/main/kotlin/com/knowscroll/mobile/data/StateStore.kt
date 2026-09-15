package com.knowscroll.mobile.data

import android.content.Context
import org.json.JSONObject
import java.util.UUID

data class ScrollSession(
    val decisionId: String, val item: ScrollItem,
    val clientExposureId: String = UUID.randomUUID().toString(),
    val clientEventId: String = UUID.randomUUID().toString(),
    val exposureId: String = "", val exposureEventId: String = "",
    val keepJobId: String = "", val keepEventId: String = "",
    val readingPosition: Int = 0
)

/** Persist the whole retry envelope together, not a UUID detached from its payload. */
class StateStore(context: Context) {
    private val prefs = context.getSharedPreferences("ks_session_v1", Context.MODE_PRIVATE)
    fun writeScreen(screen: String) {
        check(prefs.edit().putString("screen", screen).commit()) { "Could not save navigation" }
    }
    fun readScreen(): String = prefs.getString("screen", "universe") ?: "universe"
    fun writeVisited(assetIds: Set<String>) {
        check(prefs.edit().putStringSet("visited", assetIds.toSet()).commit()) { "Could not save navigation history" }
    }
    fun readVisited(): Set<String> = prefs.getStringSet("visited", emptySet())?.toSet() ?: emptySet()
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
            put("readingPosition", s.readingPosition)
        }
        check(prefs.edit().putString("session", json.toString())
            .putString("readingAssetId",s.item.assetId).putInt("readingPosition",s.readingPosition).commit()) { "Could not save the retry envelope" }
    }
    fun writeReadingPosition(assetId: String, position: Int) {
        check(prefs.edit().putString("readingAssetId",assetId).putInt("readingPosition",position).commit()) { "Could not save reading position" }
    }
    fun read(): ScrollSession? {
        val raw = prefs.getString("session", null) ?: return null
        val o = JSONObject(raw); val i = o.getJSONObject("item")
        val item = ScrollItem(i.getString("assetId"),i.getInt("revision"),i.getString("kind"),i.getString("title"),i.getString("summary"),i.getString("body"),i.getString("sourceTitle"),i.getString("sourceUrl"),i.getString("truthState"),i.getString("reason"))
        val position=if(prefs.getString("readingAssetId",null)==item.assetId) prefs.getInt("readingPosition",0) else o.optInt("readingPosition",0)
        return ScrollSession(o.getString("decisionId"),item,o.getString("clientExposureId"),o.getString("clientEventId"),o.getString("exposureId"),o.getString("exposureEventId"),o.getString("keepJobId"),o.getString("keepEventId"),position)
    }
}
