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
    val readingPosition: Int = 0,
    /** #131: set when this session was opened by taking a live continuation. */
    val branchFrom: BranchFrom? = null
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

const val MAX_BRANCH_TRAIL = 8

/** The Cable mode [session] is read in, and so the bank that keeps it. A discovery is read in its
 * own kind's mode; a continuation (always a Scroll) stays in the mode it was followed in, [current]:
 * following one from a Reel keeps Reel mode (#183, ADR-0043 §5). */
internal fun cableModeFor(session: ScrollSession, current: String): String =
    if (session.branchFrom == null) session.item.kind else current

/** #135: one persisted privacy-lifecycle retry envelope. See [StateStore.writePendingPrivacyRequest].
 * [mayHaveLanded]: an earlier attempt of this request may have been applied without its answer
 * arriving (a lost response, a 5xx). [inFlight]: an attempt was dispatched and its outcome never
 * recorded -- read after a process restart, the process died with it in flight, so it may have
 * landed too. Only Reset and account deletion, which end the calling session, need either. */
data class PendingPrivacyRequest(
    val requestId: String,
    val expectedPrivacyEpoch: Long,
    val mayHaveLanded: Boolean = false,
    val inFlight: Boolean = false,
)

/** Persist the whole retry envelope together, not a UUID detached from its payload. */
class StateStore(context: Context) {
    private val prefs = context.getSharedPreferences("ks_session_v1", Context.MODE_PRIVATE)
    fun writeScreen(screen: String) {
        if (readScreen() == screen) return
        check(prefs.edit().putString("screen", screen).commit()) { "Could not save navigation" }
    }
    fun readCableMode(): String = (prefs.getString("cableMode", null)
        ?: runCatching { read()?.item?.kind }.getOrNull()).takeIf { it in setOf("Scroll", "Reel") } ?: "Scroll"
    fun writeCableMode(kind: String) { require(kind in setOf("Scroll", "Reel")); if (readCableMode() == kind) return; check(prefs.edit().putString("cableMode",kind).commit()) }
    fun readCableSession(kind: String): ScrollSession? = read("session_$kind")
    fun readSelectedCableSession(): ScrollSession? {
        val kind = readCableMode()
        return readCableSession(kind) ?: read()?.takeIf { it.item.kind == kind }
    }
    fun readScreen(): String = prefs.getString("screen", "universe") ?: "universe"
    fun writeVisited(assetIds: Set<String>) {
        check(prefs.edit().putStringSet("visited", assetIds.toSet()).commit()) { "Could not save navigation history" }
    }
    fun readVisited(): Set<String> = prefs.getStringSet("visited", emptySet())?.toSet() ?: emptySet()
    private fun sessionJson(s: ScrollSession): JSONObject {
        val item = JSONObject().apply {
            put("assetId", s.item.assetId); put("revision", s.item.revision); put("kind", s.item.kind)
            put("title", s.item.title); put("summary", s.item.summary); put("body", s.item.body)
            put("sourceTitle", s.item.sourceTitle); put("sourceUrl", s.item.sourceUrl)
            put("truthState", s.item.truthState); put("reason", s.item.reason)
            s.item.media?.let { put("media",it.toJson()) }
        }
        return JSONObject().apply {
            put("decisionId", s.decisionId); put("item", item)
            put("privacyEpoch", s.privacyEpoch)
            put("universeId", s.universeId)
            put("clientExposureId", s.clientExposureId); put("clientEventId", s.clientEventId)
            put("exposureId", s.exposureId); put("exposureEventId", s.exposureEventId)
            put("keepJobId", s.keepJobId); put("keepEventId", s.keepEventId)
            put("readingPosition", s.readingPosition)
            s.branchFrom?.let { put("branchFrom", it.toJson()) }
        }
    }

    private fun parseSession(o: JSONObject, position: Int? = null): ScrollSession {
        val i = o.getJSONObject("item")
        val item = ScrollItem(i.getString("assetId"),i.getInt("revision"),i.getString("kind"),i.getString("title"),i.getString("summary"),i.getString("body"),i.getString("sourceTitle"),i.getString("sourceUrl"),i.getString("truthState"),i.getString("reason"),i.optJSONObject("media")?.let { ReelMedia.parse(it) })
        return ScrollSession(o.getString("decisionId"),item,o.optLong("privacyEpoch",0),o.optString("universeId",""),o.getString("clientExposureId"),o.getString("clientEventId"),o.getString("exposureId"),o.getString("exposureEventId"),o.getString("keepJobId"),o.getString("keepEventId"),position ?: o.optInt("readingPosition",0),o.optJSONObject("branchFrom")?.let { BranchFrom.parse(it) })
    }

    fun write(s: ScrollSession) {
        val json = sessionJson(s)
        check(prefs.edit().putString("session", json.toString()).putString("session_${cableModeFor(s, readCableMode())}", json.toString())
            .putString("readingAssetId",s.item.assetId).putInt("readingPosition",s.readingPosition).commit()) { "Could not save the retry envelope" }
    }

    /** #131: the Scrolls a reader branched away from, newest last, each with its own exact
     * reading position and retry envelope. Bounded; purged with all private state. */
    fun writeBranchTrail(trail: List<ScrollSession>) {
        val arr = org.json.JSONArray().apply { trail.takeLast(MAX_BRANCH_TRAIL).forEach { put(sessionJson(it)) } }
        check(prefs.edit().putString("branchTrail", arr.toString()).commit()) { "Could not save the branch trail" }
    }
    fun readBranchTrail(): List<ScrollSession> {
        val raw = prefs.getString("branchTrail", null) ?: return emptyList()
        return runCatching { val arr = org.json.JSONArray(raw); List(arr.length()) { parseSession(arr.getJSONObject(it)) } }.getOrDefault(emptyList())
    }

    fun writePendingBranch(r: BranchOpenRequest) {
        val json = JSONObject().apply {
            put("clientBranchId", r.clientBranchId); put("fromExposureId", r.fromExposureId); put("bridgeId", r.bridgeId)
            put("targetAssetId", r.targetAssetId); put("expectedPrivacyEpoch", r.expectedPrivacyEpoch); put("universeId", r.universeId)
        }
        check(prefs.edit().putString("pendingBranch", json.toString()).commit()) { "Could not save the branch request" }
    }
    fun readPendingBranch(): BranchOpenRequest? {
        val raw = prefs.getString("pendingBranch", null) ?: return null
        return runCatching { val o = JSONObject(raw); BranchOpenRequest(o.getString("clientBranchId"), o.getString("fromExposureId"), o.getString("bridgeId"), o.getString("targetAssetId"), o.getLong("expectedPrivacyEpoch"), o.getString("universeId")) }.getOrNull()
    }
    fun clearPendingBranch() { check(prefs.edit().remove("pendingBranch").commit()) { "Could not clear the branch request" } }

    /** #132: the persisted retry envelope for `POST /v1/asks`, written before dispatch so an
     * ambiguous failure can retry with the same clientAskId instead of recording a duplicate. */
    fun writePendingAsk(r: PendingAsk) {
        val json = JSONObject().apply {
            put("clientAskId", r.clientAskId); put("exposureId", r.exposureId)
            put("expectedPrivacyEpoch", r.expectedPrivacyEpoch); put("question", r.question)
        }
        check(prefs.edit().putString("pendingAsk", json.toString()).commit()) { "Could not save the Ask request" }
    }
    fun readPendingAsk(): PendingAsk? {
        val raw = prefs.getString("pendingAsk", null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            PendingAsk(o.getString("clientAskId"), o.getString("exposureId"), o.getLong("expectedPrivacyEpoch"), o.getString("question"))
        }.getOrNull()
    }
    fun clearPendingAsk() { check(prefs.edit().remove("pendingAsk").commit()) { "Could not clear the Ask request" } }

    /** #132: the persisted retry envelope for `POST /v1/asks/:id/answer`. */
    fun writePendingAnswerRequest(r: PendingAnswerRequest) {
        val json = JSONObject().apply {
            put("clientRequestId", r.clientRequestId); put("askId", r.askId); put("expectedPrivacyEpoch", r.expectedPrivacyEpoch)
        }
        check(prefs.edit().putString("pendingAnswerRequest", json.toString()).commit()) { "Could not save the answer request" }
    }
    fun readPendingAnswerRequest(): PendingAnswerRequest? {
        val raw = prefs.getString("pendingAnswerRequest", null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            PendingAnswerRequest(o.getString("clientRequestId"), o.getString("askId"), o.getLong("expectedPrivacyEpoch"))
        }.getOrNull()
    }
    fun clearPendingAnswerRequest() { check(prefs.edit().remove("pendingAnswerRequest").commit()) { "Could not clear the answer request" } }

    /** #166: the answer being waited for, so it survives the process (see [WatchedAnswer]). */
    fun writeWatchedAnswer(w: WatchedAnswer) {
        val json = JSONObject().apply {
            put("askId", w.askId); put("assetId", w.assetId); put("expectedPrivacyEpoch", w.expectedPrivacyEpoch); put("question", w.question)
        }
        check(prefs.edit().putString("watchedAnswer", json.toString()).commit()) { "Could not save the answer being waited for" }
    }
    fun readWatchedAnswer(): WatchedAnswer? {
        val raw = prefs.getString("watchedAnswer", null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            WatchedAnswer(o.getString("askId"), o.getString("assetId"), o.getLong("expectedPrivacyEpoch"), o.getString("question"))
        }.getOrNull()
    }
    fun clearWatchedAnswer() { check(prefs.edit().remove("watchedAnswer").commit()) { "Could not clear the answer being waited for" } }

    /** #132/ADR-0038: the persisted retry envelope for `PUT /v1/inquiries/consent` -- the client
     * request id with the exact content and the epoch it was sent with, written before dispatch.
     * Personal history: [purgePrivateState] drops it. */
    fun writePendingInquiryConsent(r: InquiryConsentRequest) {
        val json = JSONObject().apply {
            put("clientRequestId", r.clientRequestId); put("enabled", r.enabled)
            put("dailyLimit", r.dailyLimit); put("expectedPrivacyEpoch", r.expectedPrivacyEpoch)
        }
        check(prefs.edit().putString("pendingInquiryConsent", json.toString()).commit()) { "Could not save the consent change" }
    }
    fun readPendingInquiryConsent(): InquiryConsentRequest? {
        val raw = prefs.getString("pendingInquiryConsent", null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            InquiryConsentRequest(o.getString("clientRequestId"), o.getBoolean("enabled"), o.getInt("dailyLimit"), o.getLong("expectedPrivacyEpoch"))
        }.getOrNull()
    }
    fun clearPendingInquiryConsent() { check(prefs.edit().remove("pendingInquiryConsent").commit()) { "Could not clear the consent change" } }

    /** Position is not a retry envelope. Apply in memory now and serialize disk work off-main. */
    fun writeReadingPosition(assetId: String, position: Int) {
        val edit = prefs.edit().putString("readingAssetId",assetId).putInt("readingPosition",position)
        for (key in listOf("session", "session_Scroll", "session_Reel")) {
            val raw = prefs.getString(key, null) ?: continue
            val json = JSONObject(raw)
            if (json.getJSONObject("item").getString("assetId") == assetId) {
                json.put("readingPosition",position); edit.putString(key,json.toString())
            }
        }
        edit.apply()
    }
    fun read(key: String = "session"): ScrollSession? {
        val raw = prefs.getString(key, null) ?: return null
        val o = JSONObject(raw)
        val assetId = o.getJSONObject("item").getString("assetId")
        val position=if(prefs.getString("readingAssetId",null)==assetId) prefs.getInt("readingPosition",0) else o.optInt("readingPosition",0)
        return parseSession(o, position)
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
    /** #135: a new sign-in is not the signed-out device any more. */
    fun clearSignedOut() {
        check(prefs.edit().remove("signedOut").commit()) { "Could not clear signed-out state" }
    }

    /** #135: one privacy-lifecycle intent's in-flight retry envelope (`pause`/`resume`/`export`/
     * `reset`/`delete`), persisted before dispatch so process death never silently drops or
     * duplicates it -- the exact pattern [writePendingClear] already uses for Clear History. Each
     * intent has its own slot; they are independent (e.g. a pending pause survives a concurrent
     * export). Deliberately NOT touched by [purgePrivateState]: a destructive intent's own
     * completion handler clears its slot itself, after the server has confirmed the outcome. */
    fun writePendingPrivacyRequest(
        intent: String, requestId: String, expectedPrivacyEpoch: Long,
        mayHaveLanded: Boolean = false, inFlight: Boolean = false,
    ) {
        val json = JSONObject().apply {
            put("requestId", requestId); put("expectedPrivacyEpoch", expectedPrivacyEpoch)
            put("mayHaveLanded", mayHaveLanded); put("inFlight", inFlight)
        }
        check(prefs.edit().putString(privacyRequestKey(intent), json.toString()).commit()) {
            "Could not save the pending $intent request"
        }
    }

    fun readPendingPrivacyRequest(intent: String): PendingPrivacyRequest? {
        val raw = prefs.getString(privacyRequestKey(intent), null) ?: return null
        return runCatching {
            val json = JSONObject(raw)
            PendingPrivacyRequest(
                json.getString("requestId"), json.getLong("expectedPrivacyEpoch"),
                json.optBoolean("mayHaveLanded", false), json.optBoolean("inFlight", false),
            )
        }.getOrNull()
    }

    fun clearPendingPrivacyRequest(intent: String) {
        check(prefs.edit().remove(privacyRequestKey(intent)).commit()) {
            "Could not clear the pending $intent request"
        }
    }

    private fun privacyRequestKey(intent: String) = "pendingPrivacy_$intent"

    /** Removes only private encounter/navigation state and retains the monotonic privacy epoch. */
    @Synchronized fun purgePrivateState(universeId: String, epoch: Long) {
        val observed = if(readObservedUniverseId()==universeId)maxOf(readObservedPrivacyEpoch(),epoch) else epoch
        check(prefs.edit()
            .remove("session").remove("session_Scroll").remove("session_Reel").remove("readingAssetId").remove("readingPosition")
            .remove("branchTrail").remove("pendingBranch")
            .remove("pendingAsk").remove("pendingAnswerRequest").remove("watchedAnswer")
            .remove("pendingInquiryConsent")
            .remove("revisit")
            .remove("visited").remove("pendingHistoryClear")
            .putString("screen", "universe").putString("privacyUniverseId",universeId)
            .putLong("privacyEpoch", observed).commit()) {
            "Could not purge local Scroll history"
        }
    }
}
