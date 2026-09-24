package com.knowscroll.mobile.ui.system

import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.AtlasBasis
import com.knowscroll.mobile.data.AtlasBridgeSupport
import com.knowscroll.mobile.data.AtlasChronicleEntry
import com.knowscroll.mobile.data.AtlasClaim
import com.knowscroll.mobile.data.AtlasDelta
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasRelation
import com.knowscroll.mobile.data.AtlasResponse
import com.knowscroll.mobile.data.RoomChronicleEntry
import com.knowscroll.mobile.data.RoomClaim

/*
 * #134 — pure mapping from the reader's places (ADR-0036) to the existing `AtlasMarker`/region
 * seams `SpatialAtlas` already renders, and the copy shown for a place's basis/evidence. Kept out
 * of the ViewModel and out of Compose so the mapping, wording and conflict rules are unit-testable
 * without a live ViewModel or a running server -- mirrors `ui/branch/BranchPresentation.kt`.
 * #161: the wording never names or points at a source; the claim itself is what the reader sees.
 */

fun placeMarkerDetail(place: AtlasPlace): String {
    val total = place.scrolls.total
    return "${place.scrolls.seen} of $total ${if (total == 1) "Scroll" else "Scrolls"} read"
}

/** Empty for a sighting: the wire contract already refuses attention on something unshown. */
fun placeMarkerStatus(place: AtlasPlace): String = place.attention?.state?.uppercase() ?: ""

/** The system-level markers for live planets, in `SpatialAtlas`'s existing marker shape. */
fun planetMarkersOf(places: List<AtlasPlace>): List<AtlasMarker> =
    places.filter { it.kind == "planet" }
        .map {
            AtlasMarker(it.placeId, it.anchor.name, placeMarkerDetail(it), placeMarkerStatus(it), foundation = it.foundation != null, room = it.rooms.isNotEmpty())
        }

/** Faint markers next to their parent: `SpatialAtlas` positions each near its parent's own point
 * via [sightingOffset], never through the independent [atlasLayout] orbit. */
fun sightingMarkersOf(places: List<AtlasPlace>): List<AtlasMarker> =
    places.filter { it.kind == "sighting" }
        .mapNotNull { s -> s.parentPlaceId?.let { parent -> AtlasMarker(s.placeId, s.anchor.name, "Sighting", parentId = parent) } }

/** The live region places under one planet, laid out as land areas at the continents level. Empty
 * when the planet has no regions yet -- the caller shows the planet's own area and a quiet line. */
fun regionAreasOf(places: List<AtlasPlace>, planetId: String): List<AtlasRegionArea> {
    val regions = places.filter { it.kind == "region" && it.parentPlaceId == planetId }
    val points = regionAreaLayout(regions.map { it.placeId }).associateBy { it.id }
    return regions.mapNotNull { r -> points[r.placeId]?.let { p -> AtlasRegionArea(r.placeId, r.anchor.name, p.x, p.y, room = r.rooms.isNotEmpty()) } }
}

/** ADR-0036's Cartographer wording (`packages/core/src/atlas/chronicle.ts`'s `VERB` table),
 * mirrored so a sighting's own basis (already name-resolved on the wire) reads the same way. */
internal val ATLAS_RELATION_VERB: Map<String, String> = mapOf(
    "explains" to "explains", "prerequisite_for" to "comes before", "contradicts" to "is in tension with",
    "analogous_in" to "works like", "applies_to" to "applies to", "compares_mechanism" to "can be compared with",
)

/** "Gravity explains Star formation" -- from the sighting's own basis, already resolved to names. */
fun basisSentence(basis: AtlasBasis): String = "${basis.from} ${ATLAS_RELATION_VERB.getValue(basis.kind)} ${basis.to}"

/** What a connection rests on: its claim, quoted, or the admitted bridge's mechanism. */
fun supportLine(claim: AtlasClaim?, bridge: AtlasBridgeSupport?): String? = claim?.let { "\"${it.text}\"" } ?: bridge?.mechanism

/** The sentence for a typed relation between two live places, from [thisPlaceId]'s own side. */
fun placeRelationSentence(relation: AtlasRelation, thisPlaceId: String, places: List<AtlasPlace>): String? {
    val name = { id: String -> places.firstOrNull { it.placeId == id }?.anchor?.name }
    val thisName = name(thisPlaceId) ?: return null
    val forward = relation.fromPlaceId == thisPlaceId
    val otherName = name(if (forward) relation.toPlaceId else relation.fromPlaceId) ?: return null
    val verb = ATLAS_RELATION_VERB[relation.kind] ?: return null
    return if (forward) "$thisName $verb $otherName" else "$otherName $verb $thisName"
}

/** This place's own chronicle lines, newest first as the server already ordered them -- its own
 * changes (formed, set aside) and the changes of what belonged to it at the time (a sighting
 * appearing/retiring, a region released), never only a bare `placeId` match (review I2: a set-aside
 * planet's own "You set X aside." line has `placeId == place`, but a sighting's own line about
 * itself has `placeId` of the *sighting* and `parentPlaceId` of this place). */
fun chronicleFor(response: AtlasResponse, placeId: String): List<AtlasChronicleEntry> =
    response.chronicle.filter { it.placeId == placeId || it.parentPlaceId == placeId }

/** What a chronicle line's evidence says, honestly limited to the fields ADR-0036's Cartographer
 * actually records for that delta kind (`packages/core/src/atlas/cartographer.ts`). */
fun evidenceSummary(delta: AtlasDelta): String = when (delta.kind) {
    "place_formed" -> {
        val account = delta.evidence["account"] as? Map<*, *>
        val episodes = (account?.get("episodes") as? Number)?.toInt()
        val days = (account?.get("daysActive") as? Number)?.toInt()
        if (episodes != null && days != null)
            "Formed from $episodes reading${if (episodes == 1) "" else "s"} across $days day${if (days == 1) "" else "s"}."
        else "Formed from your reading."
    }
    "sighting_appeared" -> {
        val relation = delta.evidence["relation"] as? Map<*, *>
        val verb = (relation?.get("kind") as? String)?.let(ATLAS_RELATION_VERB::get)
        val support = delta.evidence["relationSupport"] as? Map<*, *>
        val claim = support?.get("claim") as? Map<*, *>
        val bridge = support?.get("bridge") as? Map<*, *>
        val claimText = (claim?.get("text") as? String)?.let { text -> "\"$text\"" }
        val supportText = claimText ?: (bridge?.get("mechanism") as? String)
        listOfNotNull(verb?.let { "A connection that $it." }, supportText).joinToString(" ").ifBlank { "A neighbouring idea." }
    }
    // #134 review 2: a sighting the reader came across retires as their own exploration -- the
    // server's evidence names what happened (`evidence.met`), so "no longer active" would be false.
    "sighting_retired" -> when (delta.causalClass) {
        "source_correction" -> "What this connection was based on changed."
        "personal_exploration" -> {
            val met = delta.evidence["met"] as? Map<*, *>
            val episodes = (met?.get("episodes") as? Number)?.toInt()
            if (episodes != null) "You came across it ($episodes reading${if (episodes == 1) "" else "s"}), so it is no longer on the horizon."
            else "You came across it, so it is no longer on the horizon."
        }
        else -> "This connection is no longer active."
    }
    "place_rejected" -> "You set this place aside."
    "place_released" -> "Its planet was set aside, so this region now stands on its own."
    "foundation_recognised" -> {
        val relations = (delta.evidence["relations"] as? List<*>)?.size
        val holdsUp = (delta.evidence["holdsUp"] as? List<*>)?.size
        val connections = relations?.let { "$it connection${if (it == 1) "" else "s"}" }
        val places = holdsUp?.let { "$it of your places" }
        // Before and after both load-bearing: its connections changed while it stood (ADR-0037).
        val revised = delta.before?.get("loadBearing") == true
        when {
            connections == null || places == null -> "Recognised from its connections to your places."
            !revised -> "Recognised from $connections to $places."
            delta.causalClass == "reader_correction" -> "After you set a place aside, it still stands on $connections to $places."
            delta.causalClass == "source_correction" -> "What it was based on changed; it now stands on $connections to $places."
            else -> "It now holds up $places, through $connections."
        }
    }
    "foundation_withdrawn" -> when {
        delta.evidence["setAside"] == true -> "You set this place aside, so it no longer holds anything up."
        delta.causalClass == "source_correction" -> "What one of its connections was based on changed."
        else -> "After you set a place aside, it no longer has enough connections to your places."
    }
    else -> "This place changed."
}

enum class SetAsideConflict { StaleEpoch, Paused }

/** A 409 from setting a place aside (`POST /v1/atlas/places/:placeId/reject`) or a room (#163,
 * `POST /v1/rooms/:roomId/set-aside`) is either a stale privacy epoch (reconcile, same as every
 * other mutation) or recording being paused (an honest message; nothing to reconcile since nothing
 * personal was recorded) -- mirrors `ui/branch/BranchPresentation.kt`'s `branchOpenConflict`.
 * Review M6: matches the servers' own two 409 reasons explicitly ("Privacy epoch changed" and
 * "Recording is paused" -- `packages/db/src/atlas.ts`, `packages/db/src/rooms.ts`); any other 409
 * (a room no longer live, or a reason these endpoints are not known to send) returns `null`, so the
 * caller falls back to a generic message rather than assuming it must mean paused. */
fun setAsideConflict(error: ApiException.Server): SetAsideConflict? {
    if (error.statusCode != 409) return null
    val body = error.message ?: ""
    return when {
        body.contains("privacy epoch", ignoreCase = true) -> SetAsideConflict.StaleEpoch
        body.contains("paused", ignoreCase = true) -> SetAsideConflict.Paused
        else -> null
    }
}

/** One row in the reader's own places list (review I3): every live place, depth-first under its
 * parent -- a planet at depth 0, its direct regions/sightings at depth 1, a region's own regions/
 * sightings at depth 2, and so on. Alphabetical within a parent, for a deterministic order. Where
 * `regionAreasOf`/`SpatialAtlas` only ever draw a planet's *direct* regions and sightings whose
 * parent is a planet marker, this list is complete regardless of nesting depth or parent kind. */
data class PlaceListRow(val placeId: String, val kind: String, val name: String, val depth: Int, val detail: String)

fun placeListRows(places: List<AtlasPlace>): List<PlaceListRow> {
    // Review 3: a place whose declared parent is not itself in this payload (e.g. paged, or a
    // stale/foreign reference) is never silently dropped -- it is walked as a top-level row instead.
    val ids = places.mapTo(mutableSetOf()) { it.placeId }
    val byParent = places.groupBy { if (it.parentPlaceId != null && it.parentPlaceId in ids) it.parentPlaceId else null }
    val rows = mutableListOf<PlaceListRow>()
    fun walk(parentId: String?, depth: Int) {
        byParent[parentId].orEmpty().sortedBy { it.anchor.name }.forEach { p ->
            val detail = when {
                p.kind == "sighting" -> "Sighting"
                else -> listOfNotNull(placeMarkerDetail(p), "Foundation".takeIf { p.foundation != null }, roomsDetail(p)).joinToString(" · ")
            }
            rows += PlaceListRow(p.placeId, p.kind, p.anchor.name, depth, detail)
            if (p.kind != "sighting") walk(p.placeId, depth + 1)
        }
    }
    walk(null, 0)
    return rows
}

/** The planet at the root of [placeId]'s own parent chain (itself, if it already is one) -- the
 * only kind `SpatialAtlas`'s own camera/marker selection understands. */
tailrec fun topmostAncestor(places: List<AtlasPlace>, placeId: String): String {
    val place = places.firstOrNull { it.placeId == placeId } ?: return placeId
    val parentId = place.parentPlaceId ?: return placeId
    return topmostAncestor(places, parentId)
}

/** "$N PLACES · $M SIGHTINGS" -- the system's subtitle, a straight count of the live atlas. */
fun placesSubtitle(places: List<AtlasPlace>): String {
    val liveCount = places.count { it.kind == "planet" || it.kind == "region" }
    val sightingCount = places.count { it.kind == "sighting" }
    val placeWord = if (liveCount == 1) "PLACE" else "PLACES"
    val sightingWord = if (sightingCount == 1) "SIGHTING" else "SIGHTINGS"
    return "$liveCount $placeWord · $sightingCount $sightingWord"
}

/** "Holds up Orbit, Star formation and Tides" -- a foundation's held-up places that are live in
 * this response, in the server's order; `null` when it is not a foundation. (The server re-plans
 * foundations whenever a place goes, so a held-up id missing here is only ever defensive.) */
fun holdsUpLine(place: AtlasPlace, places: List<AtlasPlace>): String? {
    val names = place.foundation?.holdsUp?.mapNotNull { id -> places.firstOrNull { it.placeId == id && it.kind != "sighting" }?.anchor?.name }
    if (names.isNullOrEmpty()) return null
    return "Holds up ${listNames(names)}"
}

/** "A", "A and B", "A, B and C" -- the Cartographer's own list wording (`chronicle.ts`). */
private fun listNames(names: List<String>): String =
    if (names.size <= 1) names.joinToString() else names.dropLast(1).joinToString(", ") + " and " + names.last()

/** A place's typed relations to other live places, each with its sentence from this place's side,
 * leaving out any its foundation section already lists (the same sentence would otherwise appear
 * twice on one sheet). */
fun placeConnections(place: AtlasPlace, atlas: AtlasResponse): List<Pair<String, AtlasRelation>> {
    val listed = place.foundation?.relations?.map(::basisSentence)?.toSet().orEmpty()
    return atlas.relations
        .filter { it.fromPlaceId == place.placeId || it.toPlaceId == place.placeId }
        .mapNotNull { relation -> placeRelationSentence(relation, place.placeId, atlas.places)?.let { it to relation } }
        .filter { (sentence, _) -> sentence !in listed }
}

/** #163 (ADR-0045): how the Atlas says a place holds an Idea Room -- on its marker, its region
 * area and its row in the places list. */
const val ROOM_MARK = "Idea room"

/** "Idea room" / "2 idea rooms" for a place that holds any; `null` otherwise. */
fun roomsDetail(place: AtlasPlace): String? = when (val n = place.rooms.size) {
    0 -> null
    1 -> ROOM_MARK
    else -> "$n idea rooms"
}

/** A room's state in words: the ladder is evidence, never a score or a count. */
fun roomStateWords(state: String): String = when (state) {
    "arguing" -> "Two readings disagree"
    "opened" -> "One reading so far"
    "set_aside" -> "You set this room aside"
    "retired" -> "This room has closed"
    // Unreachable: the parser refuses any other state.
    else -> error("Unknown room state")
}

/** An inhabitant is a seat of evidence access, named for what it reads, never a persona. */
fun roomRoleTitle(role: String): String = when (role) {
    "reader_of_record" -> "The reader of record"
    "doubter" -> "The doubter"
    "connector" -> "The connector"
    // Unreachable: the parser refuses any other role.
    else -> error("Unknown room role")
}

/** One held claim, quoted; one that a source qualifies or contradicts says so, never by whom. */
fun roomClaimLine(claim: RoomClaim): String = when (claim.supportKind) {
    "qualifies" -> "\"${claim.statement}\" (qualified)"
    "contradicts" -> "\"${claim.statement}\" (contested)"
    else -> "\"${claim.statement}\""
}

/** What a room's chronicle line rests on, from the evidence the room response carries: the days
 * the question was asked, or the claims a seat holds now (held, for one that left) and before. */
fun roomEvidenceSummary(entry: RoomChronicleEntry): String {
    val evidence = entry.evidence
    val days = evidence.asks.map { it.day }.distinct()
    val lines = listOfNotNull(
        evidence.asks.takeIf { it.isNotEmpty() }?.let {
            "Asked ${it.size} ${if (it.size == 1) "time" else "times"}, on ${listNames(days)}."
        },
        evidence.claims.takeIf { it.isNotEmpty() }?.let { claims ->
            "${if (entry.kind == "inhabitant_unseated") "It held" else "It holds"} ${claims.joinToString(" ") { roomClaimLine(it) }}"
        },
        evidence.previous.takeIf { it.isNotEmpty() }?.let { claims -> "Before, it held ${claims.joinToString(" ") { roomClaimLine(it) }}" },
    )
    return lines.joinToString("\n").ifEmpty { "Nothing more was recorded for this change." }
}
