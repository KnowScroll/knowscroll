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
    class Network(message: String) : ApiException(message)
    class Server(val statusCode: Int, body: String) : ApiException("HTTP $statusCode: $body")
    class Protocol(message: String) : ApiException(message)
    object MissingToken : ApiException("KS_DEV_TOKEN is not configured")
    class InteractionConflict(message: String) : ApiException(message)
}

class ApiClient(
    private val baseUrl: String = BuildConfig.KS_DEBUG_API_BASE,
    private val token: String = BuildConfig.KS_DEV_TOKEN,
    private val connectTimeoutMs: Int = 5_000,
    private val readTimeoutMs: Int = 8_000,
    private val maxAttempts: Int = 2
) {

    suspend fun getUniverse(): Universe = io {
        get("/v1/universe") { obj ->
            Universe(
                universeId = obj.getString("universeId"),
                revision = obj.getLong("revision"),
                privacyEpoch = obj.getLong("privacyEpoch"),
                traces = parseTraces(obj.optJSONArray("traces")),
                capabilities = parseCaps(obj.optJSONObject("capabilities"))
            )
        }
    }

    suspend fun getFeed(): FeedResponse = io {
        get("/v1/feed") { obj ->
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

    // ---- internal ----

    private suspend inline fun <T> io(crossinline block: suspend () -> T): T =
        withContext(Dispatchers.IO) { block() }

    private suspend inline fun <T> get(path: String, crossinline parse: (JSONObject) -> T): T =
        request("GET", path, null, true, setOf(200), false, parse)

    private suspend inline fun <T> post(
        path: String, body: String, expected: Set<Int>,
        treat409AsConflict: Boolean, crossinline parse: (JSONObject) -> T
    ): T = request("POST", path, body, true, expected, treat409AsConflict, parse)

    private suspend inline fun <T> request(
        method: String, path: String, body: String?, requiresAuth: Boolean,
        expected: Set<Int>, treat409AsConflict: Boolean,
        crossinline parse: (JSONObject) -> T
    ): T {
        var lastError: ApiException? = null
        var attempt = 0
        while (attempt < maxAttempts) {
            attempt++
            try {
                val (code, responseBody) = rawRequest(method, path, body, requiresAuth)
                if (code == 409 && treat409AsConflict) {
                    throw ApiException.InteractionConflict(
                        "Interaction key reused with different content"
                    )
                }
                // A 204 (e.g. session revoke) has no body; every other expected response is JSON.
                if (code in expected) return parse(JSONObject(responseBody.ifBlank { "{}" }))
                if (isTransient(code)) {
                    lastError = ApiException.Server(code, responseBody)
                    if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
                    continue
                }
                throw ApiException.Server(code, responseBody)
            } catch (e: ApiException) {
                if (e is ApiException.MissingToken || e is ApiException.InteractionConflict) throw e
                lastError = e
                if (attempt >= maxAttempts || e !is ApiException.Network) throw e
                delay(if (attempt == 1) 400L else 1_200L)
            } catch (e: ConnectException) {
                lastError = ApiException.Network("Could not connect to bootstrap service")
                if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
            } catch (e: SocketTimeoutException) {
                lastError = ApiException.Network("Bootstrap service timed out")
                if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
            } catch (e: IOException) {
                lastError = ApiException.Network(e.message ?: "Network failure")
                if (attempt < maxAttempts) delay(if (attempt == 1) 400L else 1_200L)
            }
        }
        throw lastError ?: ApiException.Network("Unknown failure")
    }

    private fun isTransient(code: Int): Boolean = code == 429 || (code in 500..599)

    private fun rawRequest(method: String, path: String, body: String?, requiresAuth: Boolean): Pair<Int, String> {
        if (requiresAuth) {
            if (token.isBlank()) throw ApiException.MissingToken
            if (baseUrl.isBlank()) throw ApiException.Network("API base URL is not configured")
        }
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            doInput = true
            instanceFollowRedirects = false
            if (requiresAuth) setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        return try {
            if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            code to text
        } finally { conn.disconnect() }
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
            summary = o.getString("summary"), body = o.getString("body"),
            sourceTitle = o.getString("sourceTitle"), sourceUrl = o.getString("sourceUrl"),
            truthState = o.getString("truthState"), reason = o.optString("reason", "")
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
