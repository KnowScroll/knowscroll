package com.knowscroll.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * #132 — background bridge inquiries (ADR-0038): the reader's standing consent
 * (`PUT /v1/inquiries/consent`) and what KnowScroll looked for (`GET /v1/inquiries`). Strict,
 * mirroring `packages/contracts/src/inquiries.ts`, which is `.strict()` on every object: an unknown
 * status, bridge status, relation or evidence role, an unexpected key, a missing required field, a
 * value out of its bounds, or a combination the contract's own refinements forbid all throw, exactly
 * like [parseAtlasResponse]. Nothing here is shown unless the server said it.
 */
data class InquiryConsent(
    val enabled: Boolean,
    /** 1..10 (default 3): inquiries opened per UTC day. */
    val dailyLimit: Int,
    /** When consent last changed in this epoch; `null` when the reader never set it. */
    val changedAt: String?,
    /** False when the deployment has no enabled inquiry route: consent is kept, nothing runs. */
    val available: Boolean,
    val usedToday: Int,
)

data class InquiryConcept(val code: String, val name: String)

data class InquiryPair(val a: InquiryConcept, val b: InquiryConcept)

data class InquiryEvidence(val claimKey: String, val statement: String, val supports: String, val sourceTitle: String, val sourceUrl: String)

/** The admitted bridge a `found` inquiry produced. [bridgeStatus] can later be `revoked` or
 * `superseded` by a source correction; the list still says what was found. */
data class InquiryFound(
    val bridgeId: String,
    val bridgeStatus: String,
    val relationType: String,
    val fromConcept: InquiryConcept,
    val toConcept: InquiryConcept,
    /** The bridge's validated mechanism: how the two places connect. */
    val sentence: String,
    val evidence: List<InquiryEvidence>,
)

data class Inquiry(
    val inquiryId: String,
    /** One of [INQUIRY_STATUSES]. */
    val status: String,
    val requestedAt: String,
    val closedAt: String?,
    /** Empty until the worker chose what to ask (and for inquiries closed before that). */
    val pairs: List<InquiryPair>,
    /** Codes (validator reasons, `shape` + rule, failure or withdrawal causes); never provider text. */
    val reasons: List<String>,
    val found: InquiryFound?,
)

data class InquiriesResponse(val privacyEpoch: Long, val consent: InquiryConsent, val inquiries: List<Inquiry>)

data class InquiryConsentResponse(val privacyEpoch: Long, val consent: InquiryConsent)

/** One explicit consent change -- also its persisted retry envelope: an ambiguous failure re-sends
 * exactly this (same client request id, content and epoch), which the server replays. */
data class InquiryConsentRequest(
    val clientRequestId: String,
    val enabled: Boolean,
    val dailyLimit: Int,
    val expectedPrivacyEpoch: Long,
)

const val INQUIRY_DAILY_LIMIT_MAX = 10
const val INQUIRY_LIST_LIMIT = 50

internal val INQUIRY_STATUSES =
    setOf("waiting", "looking", "found", "nothing_found", "did_not_hold_up", "nothing_to_ask", "failed", "withdrawn")
/** Statuses that must carry reasons (and only these may). */
internal val INQUIRY_STATUSES_WITH_REASONS = setOf("did_not_hold_up", "failed", "withdrawn", "nothing_to_ask")
/** Open statuses: the only ones without a close time. */
internal val INQUIRY_OPEN_STATUSES = setOf("waiting", "looking")
internal val INQUIRY_BRIDGE_STATUSES = setOf("admitted", "revoked", "superseded")
internal val INQUIRY_RELATION_TYPES = setOf("analogous_in", "applies_to", "prerequisite_for", "explains", "compares_mechanism")
internal val INQUIRY_EVIDENCE_ROLES = setOf("from", "to", "mechanism", "limitation")

private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
/** `z.string().datetime()`: ISO 8601 in UTC, as the server's `toISOString()` writes it. */
private val DATETIME = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$")
private val CONCEPT_CODE = Regex("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){0,5}$")
private val REASON_CODE = Regex("^[a-z][a-z0-9_]{1,63}$")
private val URL = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s/?#]+\\S*$")
private const val MAX_EPOCH = 2147483647L

internal fun parseInquiriesResponse(o: JSONObject): InquiriesResponse {
    o.requireKeys("privacyEpoch", "consent", "inquiries")
    val inquiries = o.array("inquiries").objects().map(::parseInquiry)
    require(inquiries.size <= INQUIRY_LIST_LIMIT) { "The inquiry list exceeds its $INQUIRY_LIST_LIMIT-row cap" }
    return InquiriesResponse(o.epoch("privacyEpoch"), parseInquiryConsent(o.obj("consent")), inquiries)
}

internal fun parseInquiryConsentResponse(o: JSONObject): InquiryConsentResponse {
    o.requireKeys("privacyEpoch", "consent")
    return InquiryConsentResponse(o.epoch("privacyEpoch"), parseInquiryConsent(o.obj("consent")))
}

internal fun parseInquiryConsent(o: JSONObject): InquiryConsent {
    o.requireKeys("enabled", "dailyLimit", "changedAt", "available", "usedToday")
    val dailyLimit = o.int("dailyLimit")
    require(dailyLimit in 1..INQUIRY_DAILY_LIMIT_MAX) { "Daily limit out of range" }
    val usedToday = o.int("usedToday")
    require(usedToday >= 0) { "Negative usage" }
    return InquiryConsent(o.bool("enabled"), dailyLimit, o.nullableDatetime("changedAt"), o.bool("available"), usedToday)
}

internal fun parseInquiry(o: JSONObject): Inquiry {
    o.requireKeys("inquiryId", "status", "requestedAt", "closedAt", "pairs", "reasons", "found")
    val status = o.string("status")
    require(status in INQUIRY_STATUSES) { "Unknown inquiry status" }
    val pairs = o.array("pairs").objects().map { p ->
        p.requireKeys("a", "b")
        InquiryPair(parseConcept(p.obj("a")), parseConcept(p.obj("b")))
    }
    require(pairs.size <= 3) { "An inquiry offers at most three pairs" }
    val reasonsArray = o.array("reasons")
    val reasons = List(reasonsArray.length()) { i ->
        (reasonsArray.get(i) as? String)?.takeIf { REASON_CODE.matches(it) } ?: throw IllegalArgumentException("Invalid reason code")
    }
    require(reasons.size <= 24) { "Too many reasons" }
    val found = if (o.isNull("found")) null else parseFound(o.obj("found"))
    val closedAt = o.nullableDatetime("closedAt")
    // The contract's own refinements (`inquiryWire.superRefine`).
    require((status == "found") == (found != null)) { "Only a found inquiry carries a bridge" }
    require((status in INQUIRY_STATUSES_WITH_REASONS) == reasons.isNotEmpty()) { "Reasons belong to refused, failed or withdrawn inquiries" }
    require((status in INQUIRY_OPEN_STATUSES) == (closedAt == null)) { "Only an open inquiry has no close time" }
    return Inquiry(o.uuid("inquiryId"), status, o.datetime("requestedAt"), closedAt, pairs, reasons, found)
}

private fun parseFound(o: JSONObject): InquiryFound {
    o.requireKeys("bridgeId", "bridgeStatus", "relationType", "fromConcept", "toConcept", "sentence", "evidence")
    val bridgeStatus = o.string("bridgeStatus")
    require(bridgeStatus in INQUIRY_BRIDGE_STATUSES) { "Unknown bridge status" }
    val relationType = o.string("relationType")
    require(relationType in INQUIRY_RELATION_TYPES) { "Unknown relation type" }
    val sentence = o.string("sentence")
    require(sentence.isNotEmpty() && sentence.length <= 600) { "A found bridge carries its sentence" }
    val evidence = o.array("evidence").objects().map { e ->
        e.requireKeys("claimKey", "statement", "supports", "sourceTitle", "sourceUrl")
        val supports = e.string("supports")
        require(supports in INQUIRY_EVIDENCE_ROLES) { "Unknown evidence role" }
        val url = e.string("sourceUrl")
        require(URL.matches(url)) { "Evidence source is not a URL" }
        InquiryEvidence(e.nonEmpty("claimKey"), e.nonEmpty("statement"), supports, e.nonEmpty("sourceTitle"), url)
    }
    require(evidence.size in 1..12) { "A found bridge cites its evidence" }
    return InquiryFound(o.uuid("bridgeId"), bridgeStatus, relationType, parseConcept(o.obj("fromConcept")), parseConcept(o.obj("toConcept")), sentence, evidence)
}

private fun parseConcept(o: JSONObject): InquiryConcept {
    o.requireKeys("code", "name")
    val code = o.string("code")
    require(CONCEPT_CODE.matches(code)) { "Invalid concept code" }
    val name = o.string("name")
    require(name.isNotEmpty() && name.length <= 80) { "Invalid concept name" }
    return InquiryConcept(code, name)
}

// ---- strict JSON reading: no coercion (org.json would turn "3" into 3 and 3 into "3") ----

private fun JSONObject.requireKeys(vararg names: String) {
    val actual = mutableSetOf<String>()
    keys().forEach { actual += it }
    require(actual == names.toSet()) { "Unexpected shape: ${actual.sorted()}" }
}

private fun JSONObject.string(name: String): String = get(name) as? String ?: throw IllegalArgumentException("$name is not a string")
private fun JSONObject.nonEmpty(name: String): String = string(name).also { require(it.isNotEmpty()) { "$name is empty" } }
private fun JSONObject.bool(name: String): Boolean = get(name) as? Boolean ?: throw IllegalArgumentException("$name is not a boolean")
private fun JSONObject.obj(name: String): JSONObject = get(name) as? JSONObject ?: throw IllegalArgumentException("$name is not an object")
private fun JSONObject.array(name: String): JSONArray = get(name) as? JSONArray ?: throw IllegalArgumentException("$name is not an array")
private fun JSONObject.uuid(name: String): String = string(name).also { require(UUID.matches(it)) { "$name is not a UUID" } }
private fun JSONObject.datetime(name: String): String = string(name).also { require(DATETIME.matches(it)) { "$name is not a UTC datetime" } }
private fun JSONObject.nullableDatetime(name: String): String? = if (isNull(name)) null else datetime(name)

private fun JSONObject.long(name: String): Long = when (val v = get(name)) {
    is Int -> v.toLong()
    is Long -> v
    else -> throw IllegalArgumentException("$name is not an integer")
}
private fun JSONObject.int(name: String): Int = long(name).also { require(it in Int.MIN_VALUE..Int.MAX_VALUE) { "$name out of range" } }.toInt()
private fun JSONObject.epoch(name: String): Long = long(name).also { require(it in 0..MAX_EPOCH) { "Invalid privacy epoch" } }

private fun JSONArray.objects(): List<JSONObject> = List(length()) { get(it) as? JSONObject ?: throw IllegalArgumentException("Expected an object") }
