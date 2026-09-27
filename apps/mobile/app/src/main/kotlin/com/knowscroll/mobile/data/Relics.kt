package com.knowscroll.mobile.data

import org.json.JSONObject

/**
 * #134/#165 — Relics (ADR-0039, ADR-0044): durable, private things the reader deliberately keeps --
 * a connection, one of their places, a passage of a Scroll, an answer to their own Ask -- each with
 * a truth state that shows any later correction. Strict, mirroring `packages/contracts/src/relics.ts`
 * (`.strict()` on every object): an unknown kind or state, an unexpected key, a missing field, a
 * value out of bounds, or a combination the contract's refinements forbid all throw, like
 * [parseInquiriesResponse], whose found-bridge and concept parsing this reuses. The new kinds carry
 * their kept form and state only, never a source.
 */

/** One thing the reader met that a Relic keeps, and that Keep names. */
sealed interface RelicTarget {
    data class Connection(val bridgeId: String) : DoubtTarget
    data class Place(val placeId: String) : RelicTarget
    /** One claim of a Scroll, at the revision the reader read. */
    data class Passage(val assetId: String, val revision: Int, val claimKey: String) : ObjectionTarget
    data class Answer(val askId: String) : ObjectionTarget
}

/** What "Seems wrong" names. A connection's is its ADR-0031 feedback; a place is doubted by setting
 * it aside, which has its own confirmation on the place sheet. */
sealed interface DoubtTarget : RelicTarget

/** The reader's own objection (ADR-0044 §4): a passage (that claim of that Scroll) or an answer. */
sealed interface ObjectionTarget : DoubtTarget

data class RelicProvenance(
    /** The background inquiry that found it, when it came from one (ADR-0038). */
    val inquiryId: String?,
    val validatorVersion: String,
    val citedClaimKeys: List<String>,
)

sealed interface Relic {
    val relicId: String
    val keptAt: String
    /** One of [RELIC_STATES]: `current`; `corrected` (a source correction or a newer revision changed
     * what it rests on after it was kept -- the kept form stays readable); `doubted` (the reader said
     * it seems wrong, or set the place aside). */
    val state: String
    val target: RelicTarget

    data class Connection(
        override val relicId: String, override val keptAt: String, override val state: String,
        /** The connection as it reads now, with the evidence it was admitted on. */
        val connection: InquiryFound,
        val provenance: RelicProvenance,
    ) : Relic {
        override val target get() = RelicTarget.Connection(connection.bridgeId)
    }

    /** One of the reader's places as kept: its anchor, the kind it had, and how it formed. */
    data class Place(
        override val relicId: String, override val keptAt: String, override val state: String,
        val placeId: String,
        /** `planet` | `region` | `sighting`. */
        val placeKind: String,
        val anchor: InquiryConcept,
        val formedAt: String,
        /** The chronicle's own line for the change that formed it (ADR-0036), never model text. */
        val formation: String,
    ) : Relic {
        override val target get() = RelicTarget.Place(placeId)
    }

    /** One claim of a Scroll, with the Scroll's title as the reader read it. */
    data class Passage(
        override val relicId: String, override val keptAt: String, override val state: String,
        val assetId: String, val revision: Int, val title: String,
        val claimKey: String, val statement: String,
        /** The claim has lost its current support since (M4), never said by which source. */
        val withdrawn: Boolean,
    ) : Relic {
        override val target get() = RelicTarget.Passage(assetId, revision, claimKey)
    }

    /** The reader's question and the validated answer, with the Scroll it was answered from. */
    data class Answer(
        override val relicId: String, override val keptAt: String, override val state: String,
        val askId: String, val assetId: String, val revision: Int, val title: String,
        val question: String, val answer: String, val basis: List<String>, val limits: String,
    ) : Relic {
        override val target get() = RelicTarget.Answer(askId)
    }
}

data class RelicsResponse(
    val privacyEpoch: Long,
    /** Newest first; the reader's older Relics are on [nextPage]. */
    val relics: List<Relic>,
    /** The cursor of the next older page (`GET /v1/relics?page=`), only after a full page. */
    val nextPage: String?,
    /** While recording is paused nothing new is kept; letting go still works. */
    val recordingPaused: Boolean,
)

data class RelicKeepResponse(val privacyEpoch: Long, val relic: Relic)

data class RelicReleaseResponse(val privacyEpoch: Long, val relicId: String)

/** One explicit "Keep". Idempotent server-side by [clientRequestId]: an ambiguous failure re-sends exactly this. */
data class RelicKeepRequest(val clientRequestId: String, val expectedPrivacyEpoch: Long, val target: RelicTarget)

/** "Let go": releasing one that is already gone answers the same, so a retry is this again. */
data class RelicReleaseRequest(val relicId: String, val expectedPrivacyEpoch: Long)

/** "Seems wrong" on a connection (ADR-0031, ADR-0039 §5): personal suppression, never a retraction
 * of shared knowledge. Idempotent server-side by [clientFeedbackId]. */
data class ConnectionFeedbackRequest(val clientFeedbackId: String, val bridgeId: String, val expectedPrivacyEpoch: Long, val objection: String = "seems_wrong")

/** "Seems wrong" on a passage or an answer (ADR-0044 §4). Idempotent server-side by [clientRequestId]. */
data class ObjectionRequest(val clientRequestId: String, val expectedPrivacyEpoch: Long, val target: ObjectionTarget)

data class ObjectionReceipt(val privacyEpoch: Long, val objectionId: String)

/** One claim of a Scroll the reader may keep or object to, with this reader's own state of it. */
data class ScrollPassage(val claimKey: String, val statement: String, val withdrawn: Boolean, val kept: Boolean, val seemsWrong: Boolean)

/** `GET /v1/scrolls/:assetId/passages`. */
data class PassagesResponse(
    val privacyEpoch: Long,
    val assetId: String,
    /** The Scroll's current revision: a passage is kept only at the revision the reader read. */
    val revision: Int,
    val recordingPaused: Boolean,
    val passages: List<ScrollPassage>,
)

const val RELIC_LIST_LIMIT = 100
const val PASSAGE_LIST_LIMIT = 40

internal val RELIC_STATES = setOf("current", "corrected", "doubted")
internal val RELIC_PLACE_KINDS = setOf("planet", "region", "sighting")
/** `keptAt|relicId`, the keep time at the database's microseconds (`RELIC_CURSOR_PATTERN`). */
private val RELIC_CURSOR = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z\\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
/** `semanticKey`: a claim's key. */
private val CLAIM_KEY = Regex("^[a-z][a-z0-9_.-]{2,79}$")

internal fun parseRelicsResponse(o: JSONObject): RelicsResponse {
    o.requireKeys("privacyEpoch", "relics", "nextPage", "recordingPaused")
    val relics = o.array("relics").strictObjects().map(::parseRelic)
    require(relics.size <= RELIC_LIST_LIMIT) { "The Relic list exceeds its $RELIC_LIST_LIMIT-row cap" }
    val nextPage = if (o.isNull("nextPage")) null else o.string("nextPage").also { require(RELIC_CURSOR.matches(it)) { "Invalid page cursor" } }
    // The contract's own refinement: a next page only after a full one.
    require(nextPage == null || relics.size == RELIC_LIST_LIMIT) { "A next page only after a full one" }
    return RelicsResponse(o.epoch("privacyEpoch"), relics, nextPage, o.bool("recordingPaused"))
}

internal fun parseRelicKeepResponse(o: JSONObject): RelicKeepResponse {
    o.requireKeys("privacyEpoch", "relic")
    return RelicKeepResponse(o.epoch("privacyEpoch"), parseRelic(o.obj("relic")))
}

internal fun parseRelicReleaseResponse(o: JSONObject): RelicReleaseResponse {
    o.requireKeys("privacyEpoch", "relicId", "released")
    require(o.bool("released")) { "A release receipt says it was released" }
    return RelicReleaseResponse(o.epoch("privacyEpoch"), o.uuid("relicId"))
}

internal fun parseObjectionReceipt(o: JSONObject): ObjectionReceipt {
    o.requireKeys("privacyEpoch", "objectionId")
    return ObjectionReceipt(o.epoch("privacyEpoch"), o.uuid("objectionId"))
}

internal fun parsePassagesResponse(o: JSONObject): PassagesResponse {
    o.requireKeys("privacyEpoch", "assetId", "revision", "recordingPaused", "passages")
    val passages = o.array("passages").strictObjects().map { p ->
        p.requireKeys("claimKey", "statement", "withdrawn", "kept", "seemsWrong")
        ScrollPassage(p.claimKey(), p.bounded("statement", 400), p.bool("withdrawn"), p.bool("kept"), p.bool("seemsWrong"))
    }
    require(passages.size <= PASSAGE_LIST_LIMIT) { "The passage list exceeds its $PASSAGE_LIST_LIMIT-row cap" }
    return PassagesResponse(o.epoch("privacyEpoch"), o.uuid("assetId"), o.revision("revision"), o.bool("recordingPaused"), passages)
}

internal fun parseRelic(o: JSONObject): Relic {
    val state = o.string("state")
    require(state in RELIC_STATES) { "Unknown Relic state" }
    return when (o.string("kind")) {
        "connection" -> {
            o.requireKeys("relicId", "kind", "keptAt", "state", "connection", "provenance")
            val connection = parseInquiryFound(o.obj("connection"))
            // The contract's own refinement: a correction is never hidden, and never claimed for a
            // connection that still stands.
            require((state == "corrected") == (connection.bridgeStatus != "admitted")) { "Corrected exactly when the connection is no longer admitted" }
            val p = o.obj("provenance")
            p.requireKeys("inquiryId", "validatorVersion", "citedClaimKeys")
            val validatorVersion = p.bounded("validatorVersion", 80)
            val keysArray = p.array("citedClaimKeys")
            val cited = List(keysArray.length()) { i ->
                (keysArray.get(i) as? String)?.takeIf { it.isNotEmpty() && it.length <= 200 } ?: throw IllegalArgumentException("Invalid claim key")
            }
            require(cited.size in 1..12) { "A Relic cites the claims it was admitted on" }
            val inquiryId = if (p.isNull("inquiryId")) null else p.uuid("inquiryId")
            Relic.Connection(o.uuid("relicId"), o.datetime("keptAt"), state, connection, RelicProvenance(inquiryId, validatorVersion, cited))
        }
        "place" -> {
            o.requireKeys("relicId", "kind", "keptAt", "state", "place")
            val p = o.obj("place")
            p.requireKeys("placeId", "kind", "anchor", "formedAt", "formation")
            val kind = p.string("kind")
            require(kind in RELIC_PLACE_KINDS) { "Unknown place kind" }
            Relic.Place(o.uuid("relicId"), o.datetime("keptAt"), state, p.uuid("placeId"), kind, parseInquiryConcept(p.obj("anchor")),
                p.datetime("formedAt"), p.bounded("formation", 600))
        }
        "passage" -> {
            o.requireKeys("relicId", "kind", "keptAt", "state", "passage")
            val p = o.obj("passage")
            p.requireKeys("assetId", "revision", "title", "claim")
            val claim = p.obj("claim")
            claim.requireKeys("claimKey", "statement", "withdrawn")
            val withdrawn = claim.bool("withdrawn")
            // The contract's own refinement: a withdrawn claim is never shown under a current or doubted passage.
            require(!withdrawn || state == "corrected") { "A passage whose claim was withdrawn is corrected" }
            Relic.Passage(o.uuid("relicId"), o.datetime("keptAt"), state, p.uuid("assetId"), p.revision("revision"), p.bounded("title", 300),
                claim.claimKey(), claim.bounded("statement", 400), withdrawn)
        }
        "answer" -> {
            o.requireKeys("relicId", "kind", "keptAt", "state", "answer")
            val a = o.obj("answer")
            a.requireKeys("askId", "assetId", "revision", "title", "question", "answer", "basis", "limits")
            val basis = a.array("basis").strictObjects().map { q -> q.requireKeys("quote"); q.bounded("quote", 400) }
            require(basis.size in 1..4) { "An answer cites one to four quotes" }
            Relic.Answer(o.uuid("relicId"), o.datetime("keptAt"), state, a.uuid("askId"), a.uuid("assetId"), a.revision("revision"), a.bounded("title", 300),
                a.bounded("question", 4096), a.bounded("answer", 1200), basis, a.bounded("limits", 400))
        }
        else -> throw IllegalArgumentException("Unknown Relic kind")
    }
}

private fun JSONObject.bounded(name: String, max: Int): String = nonEmpty(name).also { require(it.length <= max) { "$name is too long" } }
private fun JSONObject.claimKey(): String = string("claimKey").also { require(CLAIM_KEY.matches(it)) { "Invalid claim key" } }
private fun JSONObject.revision(name: String): Int = int(name).also { require(it >= 1) { "Invalid revision" } }
