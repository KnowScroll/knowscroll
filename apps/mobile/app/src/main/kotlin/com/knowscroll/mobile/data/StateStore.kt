package com.knowscroll.mobile.data

import android.content.Context
import org.json.JSONObject
import java.util.UUID

data class ScrollSession(
    val decisionId: String, val item: ScrollItem,
    val privacyEpoch: Long, val universeId: String,
    val clientExposureId: String = UUID.randomUUID().toString(),
    val clientEventId: String = UUID.randomUUID().toString(),
    val exposureId: String = "", val exposureEventId: String = "",
    val keepJobId: String = "", val keepEventId: String = "",
    val readingPosition: Int = 0
)

/** The only persisted revisit data. Content must be fetched again after process death. */
data class TraceRevisitSession(
    val eventId: String,
    val assetId: String,
    val privacyEpoch: Long,
    val universeId: String,
    val revision: Int? = null,
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
            s.item.media?.let { put("media",it.toJson()) }
        }
        val json = JSONObject().apply {
            put("decisionId", s.decisionId); put("item", item)
            put("privacyEpoch", s.privacyEpoch)
            put("universeId", s.universeId)
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
        val item = ScrollItem(i.getString("assetId"),i.getInt("revision"),i.getString("kind"),i.getString("title"),i.getString("summary"),i.getString("body"),i.getString("sourceTitle"),i.getString("sourceUrl"),i.getString("truthState"),i.getString("reason"),i.optJSONObject("media")?.let { ReelMedia.parse(it) })
        val position=if(prefs.getString("readingAssetId",null)==item.assetId) prefs.getInt("readingPosition",0) else o.optInt("readingPosition",0)
        return ScrollSession(o.getString("decisionId"),item,o.optLong("privacyEpoch",0),o.optString("universeId",""),o.getString("clientExposureId"),o.getString("clientEventId"),o.getString("exposureId"),o.getString("exposureEventId"),o.getString("keepJobId"),o.getString("keepEventId"),position)
    }

    fun writeRevisit(value: TraceRevisitSession) {
        val json = JSONObject().apply {
            put("eventId", value.eventId); put("assetId", value.assetId)
            put("privacyEpoch", value.privacyEpoch); put("universeId", value.universeId)
            value.revision?.let { put("revision", it) }
            put("readingPosition", value.readingPosition)
        }
        check(prefs.edit().putString("revisit", json.toString()).commit()) {
            "Could not save the saved-Trace identity"
        }
    }

    fun readRevisit(): TraceRevisitSession? {
        val raw = prefs.getString("revisit", null) ?: return null
        return runCatching {
            val json = JSONObject(raw)
            TraceRevisitSession(
                eventId = json.getString("eventId"), assetId = json.getString("assetId"),
                privacyEpoch = json.getLong("privacyEpoch"), universeId = json.getString("universeId"),
                revision = if (json.has("revision")) json.getInt("revision") else null,
                readingPosition = json.optInt("readingPosition", 0)
            )
        }.getOrNull()
    }

    fun clearRevisit() {
        check(prefs.edit().remove("revisit").commit()) { "Could not clear saved-Trace identity" }
    }

    fun readObservedPrivacyEpoch(): Long = prefs.getLong("privacyEpoch", 0L)
    fun readObservedUniverseId(): String = prefs.getString("privacyUniverseId", "") ?: ""

    @Synchronized fun observePrivacyState(universeId: String, epoch: Long): Long {
        val observed = if(readObservedUniverseId()==universeId)maxOf(readObservedPrivacyEpoch(),epoch) else epoch
        check(prefs.edit().putString("privacyUniverseId",universeId).putLong("privacyEpoch", observed).commit()) { "Could not save privacy state" }
        return observed
    }

    fun writePendingClear(request: HistoryClearRequest) {
        val json = JSONObject().apply {
            put("requestId", request.requestId)
            put("expectedPrivacyEpoch", request.expectedPrivacyEpoch)
            put("confirmation", request.confirmation)
            put("universeId", request.universeId)
        }
        check(prefs.edit().putString("pendingHistoryClear", json.toString()).commit()) { "Could not save pending history clear" }
    }

    fun readPendingClear(): HistoryClearRequest? {
        val raw = prefs.getString("pendingHistoryClear", null) ?: return null
        val json = JSONObject(raw)
        return HistoryClearRequest(
            requestId = json.getString("requestId"),
            expectedPrivacyEpoch = json.getLong("expectedPrivacyEpoch"),
            confirmation = json.getString("confirmation"),
            universeId = json.optString("universeId","")
        )
    }

    fun clearPendingClear() {
        check(prefs.edit().remove("pendingHistoryClear").commit()) { "Could not clear pending history clear" }
    }

    /** In-flight/uncertain sign-out (#91), persisted before dispatch like pending Clear
     * History so process death never silently drops or duplicates the request. */
    fun writePendingSignOut() {
        check(prefs.edit().putBoolean("pendingSignOut", true).commit()) { "Could not save pending sign-out" }
    }
    fun readPendingSignOut(): Boolean = prefs.getBoolean("pendingSignOut", false)
    fun clearPendingSignOut() {
        check(prefs.edit().remove("pendingSignOut").commit()) { "Could not clear pending sign-out" }
    }

    /** Durable terminal marker: this device's session is known-dead. Never cleared by
     * ordinary privacy purges; only a fresh app data reset removes it. */
    fun writeSignedOut() {
        check(prefs.edit().putBoolean("signedOut", true).commit()) { "Could not save signed-out state" }
    }
    fun readSignedOut(): Boolean = prefs.getBoolean("signedOut", false)

    /** Removes only private encounter/navigation state and retains the monotonic privacy epoch. */
    @Synchronized fun purgePrivateState(universeId: String, epoch: Long) {
        val observed = if(readObservedUniverseId()==universeId)maxOf(readObservedPrivacyEpoch(),epoch) else epoch
        check(prefs.edit()
            .remove("session").remove("readingAssetId").remove("readingPosition")
            .remove("revisit")
            .remove("visited").remove("pendingHistoryClear")
            .putString("screen", "universe").putString("privacyUniverseId",universeId)
            .putLong("privacyEpoch", observed).commit()) {
            "Could not purge local Scroll history"
        }
    }
}
