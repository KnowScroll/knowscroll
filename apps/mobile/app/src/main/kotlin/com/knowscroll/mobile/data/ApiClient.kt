package com.knowscroll.mobile.data

import com.knowscroll.mobile.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

sealed class ApiException(message: String) : Exception(message) {
    /** #135 review: whether the call that failed may nonetheless have been applied by the server --
     * a response that never arrived (timeout, dropped connection), a 5xx (a proxy can answer one
     * after the API committed), an unreadable answer to an expected status, or an *earlier*
     * attempt of the same call (this client retries once) that was any of those. A self-ending
     * request (Reset, account deletion) needs it to read a final 401 honestly. */
    open val mayHaveLanded: Boolean get() = false
    class Network(message: String, override val mayHaveLanded: Boolean = false) : ApiException(message)
    class Server(val statusCode: Int, body: String, override val mayHaveLanded: Boolean = statusCode >= 500) :
        ApiException("HTTP $statusCode: $body")
    class Protocol(message: String) : ApiException(message) {
        override val mayHaveLanded: Boolean get() = true
    }
    object MissingToken : ApiException("KS_DEV_TOKEN is not configured")
    class InteractionConflict(message: String) : ApiException(message)
}

class ApiClient(
    private val baseUrl: String = BuildConfig.KS_DEBUG_API_BASE,
    token: String = BuildConfig.KS_DEV_TOKEN,
    private val connectTimeoutMs: Int = 5_000,
    private val readTimeoutMs: Int = 8_000,
    private val maxAttempts: Int = 2,
    /** #135: the signed-in token if present; otherwise, only in a debug build, [token] (the
     * development session) if non-blank; otherwise no credential. The default closes over
     * [token] so every existing call site (fixture tests, the debug/journey preview sandboxes)
     * keeps its exact previous behaviour unchanged; production call sites pass a
     * [VaultCredentialProvider] explicitly instead. */
    private val credential: CredentialProvider = CredentialProvider { token },
    /** #135: reported once per genuine 401 on an authenticated request. Defaults to the
     * process-wide [SessionInvalidation] signal; a test may inject its own to observe it without
     * a real vault. */
    private val onUnauthorized: () -> Unit = SessionInvalidation::reportUnauthorized,
) {

    suspend fun getUniverse(): Universe = io {
        get("/v1/universe") { obj ->
            Universe(
                universeId = obj.getString("universeId"),
                revision = obj.getLong("revision"),
                privacyEpoch = obj.getLong("privacyEpoch"),
                traces = parseTraces(obj.optJSONArray("traces")),
                capabilities = parseCaps(obj.optJSONObject("capabilities")),
                recordingPausedAt = obj.optStringOrNull("recordingPausedAt"),
            )
        }
    }

    /** `exclude`: what this discovery trip has on screen or already opened (#133), so the Composer
     * never fills a slate with Scrolls the reader would skip. At most 256 ids are sent. */
    suspend fun getFeed(kind: String = "Scroll", exclude: Collection<String> = emptyList()): FeedResponse = io {
        require(kind in setOf("Scroll", "Reel"))
        get(feedPath(kind, exclude)) { obj ->
            FeedResponse(
                decisionId = obj.getString("decisionId"),
                universeId = obj.getString("universeId"),
                accountRevision = obj.getLong("accountRevision"),
                privacyEpoch = obj.getLong("privacyEpoch"),
                items = parseItems(obj.getJSONArray("items"))
            )
        }
    }

    suspend fun getHealth(): Boolean = io {
        runCatching { val (code, _) = rawRequest("GET", "/health", null, false); code in 200..299 }
            .getOrDefault(false)
    }

    /** ADR-0028/#113: a read-only view of the real, derived worlds/system geography. `system` is
     * `null` for a universe that has not yet encountered any recorded source's evidence -- never
     * an empty object (docs/contracts/bootstrap-http.md). */
    suspend fun getWorldSystem(): WorldSystemResponse = io {
        get("/v1/worlds") { obj ->
            WorldSystemResponse(
                derivationMethod = obj.getString("derivationMethod"),
                system = obj.optJSONObject("system")?.let { sys ->
                    WorldSystem(
                        systemId = sys.getString("systemId"),
                        worlds = parseWorlds(sys.getJSONArray("worlds"))
                    )
                }
            )
        }
    }

    suspend fun postExposure(req: ExposureRequest): ExposureResponse = io {
        val body = jsonObj("decisionId" to req.decisionId, "assetId" to req.assetId,
            "clientExposureId" to req.clientExposureId).toString()
        post("/v1/exposures", body, setOf(200, 201), false) { obj ->
            ExposureResponse(obj.getString("exposureId"), obj.getString("eventId"))
        }
    }

    suspend fun postInteraction(req: InteractionRequest): InteractionResponse = io {
        val body = jsonObj("clientEventId" to req.clientEventId, "exposureId" to req.exposureId,
            "assetId" to req.assetId, "kind" to req.kind).toString()
        // HTTP 409 is a conflict; an identical retry returns the original accepted receipt.
        post("/v1/interactions", body, setOf(200, 201, 202), true) { obj ->
            InteractionResponse(obj.getString("eventId"), obj.getString("jobId"), obj.getString("status"))
        }
    }

    suspend fun getEvent(eventId: String): EventStatus = io {
        get("/v1/events/$eventId") { obj ->
            EventStatus(
                eventId = obj.getString("eventId"),
                causationId = obj.optStringOrNull("causationId"),
                exposureId = obj.optStringOrNull("exposureId"),
                kind = obj.getString("kind"),
                jobId = obj.optStringOrNull("jobId"),
                jobStatus = obj.optStringOrNull("jobStatus"),
                projected = obj.optBoolean("projected", false)
            )
        }
    }

    suspend fun getTraceRevisit(eventId: String): TraceRevisit = io {
        try {
            get("/v1/traces/$eventId") { obj ->
                val names = setOf("mode", "traceEventId", "universeId", "privacyEpoch", "exposureId", "keptAt", "scroll")
                protocol(jsonNames(obj) == names && obj.getString("mode") == "kept_revisit") {
                    "Trace revisit returned an unexpected receipt shape"
                }
                val scroll = obj.getJSONObject("scroll")
                TraceRevisit(
                    traceEventId = obj.getString("traceEventId"),
                    universeId = obj.getString("universeId"),
                    privacyEpoch = obj.getLong("privacyEpoch"),
                    exposureId = obj.getString("exposureId"),
                    keptAt = obj.getString("keptAt"),
                    scroll = parseTraceRevisitScroll(scroll)
                )
            }
        } catch(error:JSONException) {
            throw ApiException.Protocol("Trace revisit returned malformed JSON")
        }
    }

    /** #131: live continuations for one encounter. A malformed or dishonest response (an empty
     * list without a reason, a branch without evidence) is a protocol error, never shown. */
    suspend fun getBranches(assetId: String): EncounterBranches = io {
        get("/v1/assets/$assetId/branches") { obj ->
            try { parseEncounterBranches(obj) }
            catch (e: IllegalArgumentException) { throw ApiException.Protocol(e.message ?: "Invalid continuations") }
            catch (e: JSONException) { throw ApiException.Protocol("Continuations returned malformed JSON") }
        }
    }

    /** #131: take one continuation. Idempotent by `clientBranchId`; a 409 means the branch is no
     * longer available (revoked, suppressed or stale epoch) and is surfaced, never retried blindly. */
    suspend fun openBranch(req: BranchOpenRequest): BranchOpenReceipt = io {
        val body = jsonObj(
            "clientBranchId" to req.clientBranchId, "fromExposureId" to req.fromExposureId,
            "bridgeId" to req.bridgeId, "targetAssetId" to req.targetAssetId,
            "expectedPrivacyEpoch" to req.expectedPrivacyEpoch,
        ).toString()
        post("/v1/branches", body, setOf(200, 201), false) { obj ->
            try {
                val branch = obj.getJSONObject("branch")
                // While recording is paused the server serves the target but stores no decision, so
                // there is nothing to record an exposure against: the session carries an empty id.
                val recorded = branch.getBoolean("recorded")
                val decisionId = if (obj.isNull("decisionId")) "" else obj.getString("decisionId")
                protocol(recorded == decisionId.isNotEmpty()) { "Branch receipt disagrees about what was recorded" }
                val feed = FeedResponse(
                    decisionId = decisionId, universeId = obj.getString("universeId"),
                    accountRevision = obj.getLong("accountRevision"), privacyEpoch = obj.getLong("privacyEpoch"),
                    items = parseItems(obj.getJSONArray("items")),
                )
                protocol(feed.items.size == 1 && feed.items[0].assetId == req.targetAssetId) { "Branch served an unexpected target" }
                protocol(branch.getString("bridgeId") == req.bridgeId) { "Branch receipt names another connection" }
                BranchOpenReceipt(
                    feed, if (branch.isNull("branchOpenId")) null else branch.getString("branchOpenId"),
                    recorded, branch.getString("bridgeId"), branch.getString("relationType"), branch.getString("direction"),
                )
            } catch (e: JSONException) { throw ApiException.Protocol("Branch receipt was malformed") }
        }
    }

    /** #133: the recorded explanation for one served encounter, or null when its decision recorded
     * none (a branch target, or a policy without candidate records). */
    suspend fun getWhy(decisionId: String, assetId: String): EncounterWhy? = io {
        try {
            get("/v1/decisions/$decisionId/why?assetId=$assetId") { obj ->
                try { parseWhy(obj).also { protocol(it.decisionId == decisionId && it.assetId == assetId) { "Explanation names another encounter" } } }
                catch (e: IllegalArgumentException) { throw ApiException.Protocol(e.message ?: "Invalid explanation") }
                catch (e: JSONException) { throw ApiException.Protocol("Explanation returned malformed JSON") }
            }
        } catch (e: ApiException.Server) { if (e.statusCode == 404) null else throw e }
    }

    /** #133 journey G: "less like this" / "wrong connection" on an encounter the Composer served. */
    suspend fun postEncounterFeedback(clientFeedbackId: String, decisionId: String, assetId: String, kind: String, expectedPrivacyEpoch: Long): EncounterFeedbackReceipt = io {
        require(kind in ENCOUNTER_CORRECTIONS)
        val body = jsonObj(
            "clientFeedbackId" to clientFeedbackId, "decisionId" to decisionId, "assetId" to assetId,
            "kind" to kind, "expectedPrivacyEpoch" to expectedPrivacyEpoch,
        ).toString()
        post("/v1/encounters/feedback", body, setOf(201), false) { obj ->
            try {
                EncounterFeedbackReceipt(obj.getString("feedbackId"), obj.getString("kind"), obj.getJSONObject("suppressed").getString("until"))
                    .also { protocol(it.kind == kind) { "Feedback receipt names another correction" } }
            } catch (e: JSONException) { throw ApiException.Protocol("Feedback receipt was malformed") }
        }
    }

    /** #131: "not useful" / "seems wrong" — suppresses a connection for this universe only. */
    suspend fun postConnectionFeedback(clientFeedbackId: String, bridgeId: String, expectedPrivacyEpoch: Long, objection: String): Unit = io {
        require(objection == "not_useful" || objection == "seems_wrong")
        val body = jsonObj(
            "clientFeedbackId" to clientFeedbackId, "bridgeId" to bridgeId,
            "expectedPrivacyEpoch" to expectedPrivacyEpoch, "objection" to objection,
        ).toString()
        post("/v1/connections/feedback", body, setOf(200, 201), false) { obj ->
            protocol(obj.optBoolean("suppressed", false) && obj.optString("bridgeId") == bridgeId) { "Feedback receipt was unexpected" }
        }
    }

    /** #132/ADR-0033: record an Ask against the reader's current exposure of this Scroll. Exact
     * retry with the same clientAskId replays the same receipt. */
    suspend fun postAsk(req: PendingAsk): AskReceipt = io {
        val body = jsonObj(
            "clientAskId" to req.clientAskId, "exposureId" to req.exposureId,
            "expectedPrivacyEpoch" to req.expectedPrivacyEpoch, "question" to req.question,
        ).toString()
        post("/v1/asks", body, setOf(201), false) { obj ->
            try {
                AskReceipt(obj.getString("askId"), obj.getString("eventId"), obj.getString("status"))
                    .also { protocol(it.status == "recorded_only") { "Ask receipt reported an unexpected status" } }
            } catch (e: JSONException) { throw ApiException.Protocol("Ask receipt was malformed") }
        }
    }

    /** #132: request an answer for a recorded Ask -- a separate, explicit reader action; never
     * sent automatically after the Ask is recorded. Exact retry with the same clientRequestId
     * returns the same requestId. */
    suspend fun requestAnswer(req: PendingAnswerRequest): AnswerRequestReceipt = io {
        val body = jsonObj("clientRequestId" to req.clientRequestId, "expectedPrivacyEpoch" to req.expectedPrivacyEpoch).toString()
        post("/v1/asks/${req.askId}/answer", body, setOf(202), false) { obj ->
            try {
                AnswerRequestReceipt(obj.getString("requestId"), obj.getString("askId"), obj.getString("jobId"), obj.getString("status"))
                    .also { protocol(it.askId == req.askId && it.status == "queued") { "Answer request receipt was unexpected" } }
            } catch (e: JSONException) { throw ApiException.Protocol("Answer request receipt was malformed") }
        }
    }

    /** #132: the answer view for one Ask, or null when no answer was ever requested for it. */
    suspend fun getAnswer(askId: String): AnswerView? = io {
        try {
            get("/v1/asks/$askId/answer") { obj ->
                try { parseAnswerView(obj).also { protocol(it.askId == askId) { "Answer view named another Ask" } } }
                catch (e: IllegalArgumentException) { throw ApiException.Protocol(e.message ?: "Invalid answer view") }
                catch (e: JSONException) { throw ApiException.Protocol("Answer view returned malformed JSON") }
            }
        } catch (e: ApiException.Server) { if (e.statusCode == 404) null else throw e }
    }

    /** #132: cancel an answer request before it has started running. */
    suspend fun cancelAnswer(askId: String, expectedPrivacyEpoch: Long): AnswerView = io {
        val body = jsonObj("expectedPrivacyEpoch" to expectedPrivacyEpoch).toString()
        post("/v1/asks/$askId/answer/cancel", body, setOf(200), false) { obj ->
            try {
                parseAnswerView(obj).also {
                    protocol(it.askId == askId && it.status is AnswerStatus.Cancelled) { "Cancel did not return a cancelled view" }
                }
            } catch (e: IllegalArgumentException) { throw ApiException.Protocol(e.message ?: "Invalid answer view") }
            catch (e: JSONException) { throw ApiException.Protocol("Cancel receipt returned malformed JSON") }
        }
    }

    /** POST /v1/session/revoke {} -> 204. Revokes only the authenticated session; the
     * caller decides what "ambiguous vs confirmed" means for its own retry policy. */
    suspend fun revokeSession(): Unit = io {
        post("/v1/session/revoke", "{}", setOf(204), false) { }
    }

    suspend fun clearScrollHistory(req: HistoryClearRequest): HistoryClearReceipt = io {
        val body = jsonObj(
            "requestId" to req.requestId,
            "expectedPrivacyEpoch" to req.expectedPrivacyEpoch,
            "confirmation" to req.confirmation
        ).toString()
        post("/v1/history/clear", body, setOf(200), false) { obj ->
            HistoryClearReceipt(
                receiptId = obj.getString("receiptId"),
                privacyEpoch = obj.getLong("privacyEpoch"),
                clearedAt = obj.getString("clearedAt")
            )
        }
    }

    // -------------------------------------------------------------------------------------------
    // #135 (ADR-0026/0034/0035): owner identity and privacy parity.
    // -------------------------------------------------------------------------------------------

    /** `POST /v1/auth/magic-link {email}` -> always 202; never distinguishes an unknown address
     * from the owner's own (ADR-0026 section 2). No credential is sent -- this route needs none. */
    suspend fun requestMagicLink(email: String): Unit = io {
        post("/v1/auth/magic-link", jsonObj("email" to email).toString(), setOf(202), false, requiresAuth = false) { }
    }

    /** `POST /v1/auth/session {token}` -> the minted bearer session, or [ApiException.Server]
     * with status 401 for every failure mode alike (expired/consumed/unknown/malformed). */
    suspend fun consumeSignInToken(token: String): SignInSessionReceipt = io {
        post("/v1/auth/session", jsonObj("token" to token).toString(), setOf(200), false, requiresAuth = false) { obj ->
            SignInSessionReceipt(
                sessionToken = obj.getString("sessionToken"), sessionId = obj.getString("sessionId"),
                deviceId = obj.getString("deviceId"), universeId = obj.getString("universeId"),
                privacyEpoch = obj.getLong("privacyEpoch"), expiresAt = obj.getString("expiresAt"),
                accountId = obj.getString("accountId"), origin = obj.getString("origin"),
            )
        }
    }

    suspend fun pauseRecording(req: PrivacyLifecycleRequest): PrivacyRecordingReceipt = io {
        post("/v1/privacy/pause", lifecycleBody(req), setOf(200), false) { parseRecordingReceipt(it) }
    }

    suspend fun resumeRecording(req: PrivacyLifecycleRequest): PrivacyRecordingReceipt = io {
        post("/v1/privacy/resume", lifecycleBody(req), setOf(200), false) { parseRecordingReceipt(it) }
    }

    /** The full export payload, exactly as the server returned it (pretty-printed), for the
     * caller to persist verbatim. Never parsed field-by-field: the contract is large and this
     * client makes no claim about any one field, only that it is handing over what the server
     * sent for this request. */
    suspend fun exportUniverse(req: PrivacyLifecycleRequest): String = io {
        post("/v1/privacy/export", lifecycleBody(req), setOf(200), false) { it.toString(2) }
    }

    suspend fun resetPersonalUniverse(req: PrivacyResetRequest): PrivacyResetReceipt = io {
        val body = jsonObj(
            "requestId" to req.requestId, "expectedPrivacyEpoch" to req.expectedPrivacyEpoch,
            "confirmation" to req.confirmation,
        ).toString()
        post("/v1/privacy/reset", body, setOf(200), false) { obj ->
            PrivacyResetReceipt(
                receiptId = obj.getString("receiptId"), epochBefore = obj.getLong("epochBefore"),
                epochAfter = obj.getLong("epochAfter"), sessionsRevoked = obj.getLong("sessionsRevoked"),
                resetAt = obj.getString("resetAt"),
            )
        }
    }

    suspend fun deleteAccount(req: AccountDeletionRequest): AccountDeletionReceipt = io {
        val body = jsonObj(
            "requestId" to req.requestId, "expectedPrivacyEpoch" to req.expectedPrivacyEpoch,
            "confirmation" to req.confirmation,
        ).toString()
        post("/v1/account/delete", body, setOf(200), false) { obj ->
            AccountDeletionReceipt(
                receiptId = obj.getString("receiptId"), epochBefore = obj.getLong("epochBefore"),
                epochAfter = obj.getLong("epochAfter"), sessionsDeleted = obj.getLong("sessionsDeleted"),
                deletedAt = obj.getString("deletedAt"),
            )
        }
    }

    private fun lifecycleBody(req: PrivacyLifecycleRequest): String =
        jsonObj("requestId" to req.requestId, "expectedPrivacyEpoch" to req.expectedPrivacyEpoch).toString()

    private fun parseRecordingReceipt(obj: JSONObject): PrivacyRecordingReceipt = PrivacyRecordingReceipt(
        receiptId = obj.getString("receiptId"), action = obj.getString("action"),
        privacyEpoch = obj.getLong("privacyEpoch"), recordingPausedAt = obj.optStringOrNull("recordingPausedAt"),
        appliedAt = obj.getString("appliedAt"),
    )

    // ---- internal ----

    private suspend inline fun <T> io(crossinline block: suspend () -> T): T =
        withContext(Dispatchers.IO) { block() }

    private suspend inline fun <T> get(path: String, crossinline parse: (JSONObject) -> T): T =
        request("GET", path, null, true, setOf(200), false, parse)

    private suspend inline fun <T> post(
        path: String, body: String, expected: Set<Int>,
        treat409AsConflict: Boolean, requiresAuth: Boolean = true, crossinline parse: (JSONObject) -> T
    ): T = request("POST", path, body, requiresAuth, expected, treat409AsConflict, parse)

    private suspend inline fun <T> request(
        method: String, path: String, body: String?, requiresAuth: Boolean,
        expected: Set<Int>, treat409AsConflict: Boolean,
        crossinline parse: (JSONObject) -> T
    ): T {
        var lastError: ApiException? = null
        var attempt = 0
        // True once any attempt of this call may have been applied without its answer (see
        // [ApiException.mayHaveLanded]); every error thrown after that carries it.
        var uncertain = false
        while (attempt < maxAttempts) {
            attempt++
            try {
                val (code, responseBody) = rawRequest(method, path, body, requiresAuth)
                // #135: a real, previously-usable credential just proved dead. Reported before
                // any expected/transient handling below -- 401 is never an expected response.
                if (code == 401 && requiresAuth) onUnauthorized()
                if (code == 409 && treat409AsConflict) {
                    throw ApiException.InteractionConflict(
                        "Interaction key reused with different content"
                    )
                }
                // A 204 (e.g. session revoke) has no body; every other expected response is JSON.
                if (code in expected) return parse(JSONObject(responseBody.ifBlank { "{}" }))
                if (isTransient(code)) {
                    // A 429 was refused outright; a 5xx may follow a commit behind a proxy.
                    if (code >= 500) uncertain = true
                    lastError = ApiException.Server(code, responseBody, uncertain)
                    if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
                    continue
                }
                throw ApiException.Server(code, responseBody, uncertain)
            } catch (e: ApiException) {
                if (e is ApiException.MissingToken || e is ApiException.InteractionConflict) throw e
                lastError = e
                if (attempt >= maxAttempts || e !is ApiException.Network) throw e
                delay(if (attempt == 1) 400L else 1_200L)
            } catch (e: ConnectException) {
                // Refused before anything was sent: only an earlier attempt could have landed.
                lastError = ApiException.Network("Could not connect to bootstrap service", uncertain)
                if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
            } catch (e: SocketTimeoutException) {
                uncertain = true
                lastError = ApiException.Network("Bootstrap service timed out", true)
                if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
            } catch (e: IOException) {
                uncertain = true
                lastError = ApiException.Network(e.message ?: "Network failure", true)
                if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
            }
        }
        throw lastError ?: ApiException.Network("Unknown failure")
    }

    private fun isTransient(code: Int): Boolean = code == 429 || (code in 500..599)

    private suspend fun rawRequest(method: String, path: String, body: String?, requiresAuth: Boolean): Pair<Int, String> {
        val resolvedToken = if (requiresAuth) credential.currentToken()?.takeIf { it.isNotBlank() } else null
        if (requiresAuth) {
            if (resolvedToken == null) throw ApiException.MissingToken
            if (baseUrl.isBlank()) throw ApiException.Network("API base URL is not configured")
        }
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            doInput = true
            instanceFollowRedirects = false
            if (requiresAuth) setRequestProperty("Authorization", "Bearer $resolvedToken")
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        return kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { conn.disconnect() }
            Dispatchers.IO.dispatch(kotlin.coroutines.EmptyCoroutineContext, Runnable {
                if (!continuation.isActive) { conn.disconnect(); return@Runnable }
                val result = runCatching {
                    try {
                        if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                        val code = conn.responseCode
                        val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
                        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                        code to text
                    } finally { conn.disconnect() }
                }
                continuation.resumeWith(result)
            })
        }
    }

    private fun parseTraces(arr: JSONArray?): List<Trace> {
        if (arr == null) return emptyList()
        return List(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            Trace(o.getString("eventId"), o.getString("assetId"), o.getString("title"), o.getString("createdAt"))
        }
    }

    private fun parseCaps(o: JSONObject?): Capabilities =
        if (o == null) Capabilities.AllFalse
        else Capabilities(o.optBoolean("reasoning", false), o.optBoolean("reels", false), o.optBoolean("worldEvolution", false))

    private fun parseItems(arr: JSONArray): List<ScrollItem> = List(arr.length()) { i ->
        val o = arr.getJSONObject(i)
        ScrollItem(
            assetId = o.getString("assetId"), revision = o.getInt("revision"),
            kind = o.getString("kind"), title = o.getString("title"),
            summary = o.getString("summary"), body = if(o.getString("kind")=="Scroll") o.getString("body") else "",
            sourceTitle = o.getString("sourceTitle"), sourceUrl = o.getString("sourceUrl"),
            truthState = o.getString("truthState"), reason = o.optString("reason", ""),
            media = when(o.getString("kind")) {
                "Scroll" -> null
                "Reel" -> try {
                    protocol(o.getString("truthState")=="synthesis") { "Invalid Reel truth state" }
                    ReelMedia.parse(o)
                } catch (_: IllegalArgumentException) { throw ApiException.Protocol("Invalid Reel media") }
                else -> throw ApiException.Protocol("Unsupported encounter kind")
            }
        )
    }

    private fun parseWorlds(arr: JSONArray): List<WorldSummary> = List(arr.length()) { i ->
        val o = arr.getJSONObject(i)
        WorldSummary(
            worldId = o.getString("worldId"),
            sourceTitle = o.getString("sourceTitle"), sourceUrl = o.getString("sourceUrl"),
            scrollCount = o.getInt("scrollCount"), seenCount = o.getInt("seenCount")
        )
    }

    /** The revisit response is strict and intentionally has no recommendation metadata. */
    private fun parseTraceRevisitScroll(o: JSONObject): ScrollItem {
        val names = setOf(
            "assetId", "revision", "kind", "title", "summary", "body",
            "sourceTitle", "sourceUrl", "truthState"
        )
        protocol(jsonNames(o) == names) { "Trace revisit returned an unexpected Scroll shape" }
        val item=ScrollItem(
            assetId = o.getString("assetId"), revision = o.getInt("revision"),
            kind = o.getString("kind"), title = o.getString("title"),
            summary = o.getString("summary"), body = o.getString("body"),
            sourceTitle = o.getString("sourceTitle"), sourceUrl = o.getString("sourceUrl"),
            truthState = o.getString("truthState"), reason = ""
        )
        protocol(item.kind=="Scroll" && item.revision>0 && item.truthState=="documented") {
            "Trace revisit returned an invalid Scroll"
        }
        return item
    }
}

private fun jsonObj(vararg pairs: Pair<String, Any?>): JSONObject {
    val obj = JSONObject()
    for ((k, v) in pairs) obj.put(k, v)
    return obj
}

private fun JSONObject.optStringOrNull(name: String): String? =
    if (isNull(name)) null else optString(name, "").ifEmpty { null }

private fun jsonNames(value:JSONObject):Set<String> {
    val names=mutableSetOf<String>()
    val iterator=value.keys()
    while(iterator.hasNext()) names.add(iterator.next())
    return names
}

private inline fun protocol(condition:Boolean,message:()->String) {
    if(!condition)throw ApiException.Protocol(message())
}

/** The feed path for one kind, with this trip's opened ids (UUIDs only, newest last, at most 256). */
internal fun feedPath(kind: String, exclude: Collection<String>): String {
    val ids = exclude.filter { UUID_PATTERN.matches(it) }.distinct().takeLast(256)
    return if (ids.isEmpty()) "/v1/feed?kinds=$kind" else "/v1/feed?kinds=$kind&exclude=${ids.joinToString(",")}"
}

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
