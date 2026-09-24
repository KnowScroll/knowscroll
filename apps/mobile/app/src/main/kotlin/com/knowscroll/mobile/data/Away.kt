package com.knowscroll.mobile.data

import org.json.JSONObject

/**
 * #134 — the return (ADR-0039 §1-2): what changed while the reader was away (`GET /v1/away`, a page
 * at a time: ADR-0044 M7) and the marker they move once they have seen it
 * (`POST /v1/away/acknowledge`). Strict, mirroring
 * `packages/contracts/src/away.ts`, which is `.strict()` on every object: an unknown kind, change,
 * cause or correction status, an unexpected key, a missing field, a value out of its bounds, or a
 * list the contract's own refinements forbid (not newest first, an item at or before the marker,
 * `more` without a full list) all throw, exactly like [parseInquiriesResponse], whose found-bridge,
 * pair and concept parsing this reuses. Nothing here is shown unless the server said it.
 */
sealed interface AwayItem {
    /** When it happened (UTC); the list is newest first. */
    val at: String

    /** A background inquiry (ADR-0038) found a connection the validator admitted. [seemsWrong]: this
     * reader marked it "seems wrong" (ADR-0044 M5), so it is neither kept nor marked again. */
    data class ConnectionFound(override val at: String, val inquiryId: String, val found: InquiryFound, val seemsWrong: Boolean) : AwayItem

    /** A proposed connection was refused; [reasons] are the validator's codes. */
    data class ConnectionDidNotHoldUp(override val at: String, val inquiryId: String, val pairs: List<InquiryPair>, val reasons: List<String>) : AwayItem

    /** The model said the sources offer no connection between [pairs]. */
    data class NothingFound(override val at: String, val inquiryId: String, val pairs: List<InquiryPair>) : AwayItem

    /** A place changed because of a source correction; [line] is the chronicle's own deterministic
     * line for the delta (ADR-0036), never model text. [cause] is always `source_correction`. */
    data class PlaceChanged(
        override val at: String, val deltaId: String, val placeId: String,
        /** One of [AWAY_PLACE_CHANGES]. */
        val change: String,
        val cause: String,
        val line: String,
    ) : AwayItem

    /** #163 (ADR-0045): an Idea Room changed because of a source correction; [line] is the Keeper's
     * own deterministic line for the delta. [cause] is always `source_correction`. */
    data class RoomChanged(
        override val at: String, val deltaId: String, val roomId: String, val placeId: String,
        /** One of [AWAY_ROOM_CHANGES]. */
        val change: String,
        val cause: String,
        val line: String,
    ) : AwayItem

    /** A connection the reader was shown as found, or kept, was [status] `revoked` or `superseded`. */
    data class ConnectionCorrected(
        override val at: String, val bridgeId: String, val status: String,
        val fromConcept: InquiryConcept, val toConcept: InquiryConcept, val seemsWrong: Boolean,
    ) : AwayItem
}

data class AwayResponse(
    val privacyEpoch: Long,
    /** The reader's marker in this epoch; `null` when they never acknowledged a return. */
    val since: String?,
    /** Newest first, all after [since], at most [AWAY_LIST_LIMIT]. */
    val items: List<AwayItem>,
    /** Unacknowledged items beyond [items] (older ones: the list keeps the newest). */
    val more: Long,
    /** The cursor of the next older page (`GET /v1/away?page=`), exactly when [more] is not zero. */
    val nextPage: String?,
    /** While recording is paused the marker cannot move (ADR-0039 §2). */
    val recordingPaused: Boolean,
)

/** One "Mark as seen": [through] is the newest item the client displayed, so what arrives while the
 * section is on screen is not swallowed. An ambiguous failure re-sends exactly this. */
data class AwayAcknowledgeRequest(val clientRequestId: String, val expectedPrivacyEpoch: Long, val through: String)

data class AwayAcknowledgeResponse(val privacyEpoch: Long, val since: String)

const val AWAY_LIST_LIMIT = 10

internal val AWAY_PLACE_CHANGES = setOf(
    "place_formed", "sighting_appeared", "sighting_promoted", "sighting_retired", "place_released",
    "foundation_recognised", "foundation_withdrawn",
)
internal val AWAY_ROOM_CHANGES = setOf("position_changed", "inhabitant_unseated", "room_retired")
internal val AWAY_CORRECTION_STATUSES = setOf("revoked", "superseded")
/** `at|kind|id`: a page's last item in the list's one total order (`AWAY_CURSOR_PATTERN`). */
private val AWAY_CURSOR = Regex(
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\|" +
        "(connection_found|connection_did_not_hold_up|nothing_found|place_changed|room_changed|connection_corrected)\\|" +
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
)

internal fun parseAwayResponse(o: JSONObject): AwayResponse {
    o.requireKeys("privacyEpoch", "since", "items", "more", "nextPage", "recordingPaused")
    val since = o.nullableDatetime("since")
    val items = o.array("items").strictObjects().map(::parseAwayItem)
    require(items.size <= AWAY_LIST_LIMIT) { "The away list exceeds its $AWAY_LIST_LIMIT-item cap" }
    val more = o.long("more")
    require(more >= 0) { "Negative count" }
    // The contract's own refinements (`awayResponse.superRefine`), compared as it compares them: as
    // the server's `toISOString()` strings.
    for (i in 1 until items.size) require(items[i].at <= items[i - 1].at) { "Items are newest first" }
    if (since != null) require(items.all { it.at > since }) { "Items are after the marker" }
    require(items.size == AWAY_LIST_LIMIT || more == 0L) { "More only when the list is full" }
    val nextPage = if (o.isNull("nextPage")) null else o.string("nextPage").also { require(AWAY_CURSOR.matches(it)) { "Invalid page cursor" } }
    require((more > 0) == (nextPage != null)) { "A next page exactly when there is more" }
    return AwayResponse(o.epoch("privacyEpoch"), since, items, more, nextPage, o.bool("recordingPaused"))
}

internal fun parseAwayItem(o: JSONObject): AwayItem = when (o.string("kind")) {
    "connection_found" -> {
        o.requireKeys("kind", "at", "inquiryId", "found", "seemsWrong")
        AwayItem.ConnectionFound(o.datetime("at"), o.uuid("inquiryId"), parseInquiryFound(o.obj("found")), o.bool("seemsWrong"))
    }
    "connection_did_not_hold_up" -> {
        o.requireKeys("kind", "at", "inquiryId", "pairs", "reasons")
        val reasons = o.array("reasons").reasonCodes()
        require(reasons.size in 1..24) { "A refused connection carries its reasons" }
        AwayItem.ConnectionDidNotHoldUp(o.datetime("at"), o.uuid("inquiryId"), awayPairs(o), reasons)
    }
    "nothing_found" -> {
        o.requireKeys("kind", "at", "inquiryId", "pairs")
        AwayItem.NothingFound(o.datetime("at"), o.uuid("inquiryId"), awayPairs(o))
    }
    "place_changed" -> {
        o.requireKeys("kind", "at", "deltaId", "placeId", "change", "cause", "line")
        val change = o.string("change")
        require(change in AWAY_PLACE_CHANGES) { "Unknown place change" }
        AwayItem.PlaceChanged(o.datetime("at"), o.uuid("deltaId"), o.uuid("placeId"), change, correctionCause(o), chronicleLine(o))
    }
    "room_changed" -> {
        o.requireKeys("kind", "at", "deltaId", "roomId", "placeId", "change", "cause", "line")
        val change = o.string("change")
        require(change in AWAY_ROOM_CHANGES) { "Unknown room change" }
        AwayItem.RoomChanged(o.datetime("at"), o.uuid("deltaId"), o.uuid("roomId"), o.uuid("placeId"), change, correctionCause(o), chronicleLine(o))
    }
    "connection_corrected" -> {
        o.requireKeys("kind", "at", "bridgeId", "status", "fromConcept", "toConcept", "seemsWrong")
        val status = o.string("status")
        require(status in AWAY_CORRECTION_STATUSES) { "Unknown correction status" }
        AwayItem.ConnectionCorrected(
            o.datetime("at"), o.uuid("bridgeId"), status,
            parseInquiryConcept(o.obj("fromConcept")), parseInquiryConcept(o.obj("toConcept")), o.bool("seemsWrong"),
        )
    }
    else -> throw IllegalArgumentException("Unknown away item kind")
}

/** Only a source correction changes a place or a room without the reader. */
private fun correctionCause(o: JSONObject): String =
    o.string("cause").also { require(it == "source_correction") { "Only a source correction changes a place or room while away" } }

private fun chronicleLine(o: JSONObject): String =
    o.string("line").also { require(it.isNotEmpty() && it.length <= 600) { "Invalid chronicle line" } }

/** An inquiry outcome on the return always names what it asked about: one to three pairs. */
private fun awayPairs(o: JSONObject): List<InquiryPair> =
    o.array("pairs").strictObjects().map(::parseInquiryPair).also { require(it.size in 1..3) { "An outcome names one to three pairs" } }

internal fun parseAwayAcknowledgeResponse(o: JSONObject): AwayAcknowledgeResponse {
    o.requireKeys("privacyEpoch", "since")
    return AwayAcknowledgeResponse(o.epoch("privacyEpoch"), o.datetime("since"))
}
