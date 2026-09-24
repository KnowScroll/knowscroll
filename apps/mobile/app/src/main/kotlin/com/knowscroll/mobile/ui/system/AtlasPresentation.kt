package com.knowscroll.mobile.ui.system

import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.AtlasBasis
import com.knowscroll.mobile.data.AtlasChronicleEntry
import com.knowscroll.mobile.data.AtlasDelta
import com.knowscroll.mobile.data.AtlasPlace
import com.knowscroll.mobile.data.AtlasRelation
import com.knowscroll.mobile.data.AtlasResponse

/**
 * #134 — pure mapping from the reader's places (ADR-0036) to the existing `AtlasMarker`/region
 * seams `SpatialAtlas` already renders, and the copy shown for a place's basis/evidence. Kept out
 * of the ViewModel and out of Compose so the mapping, wording and conflict rules are unit-testable
 * without a live ViewModel or a running server -- mirrors `ui/branch/BranchPresentation.kt`.
 */
enum class AtlasLayer { Places, Sources }

/** Places is the default once the reader has at least one live planet; otherwise Sources, with a
 * quiet explanation of when a place would first appear. */
fun defaultAtlasLayer(places: List<AtlasPlace>): AtlasLayer =
    if (places.any { it.kind == "planet" }) AtlasLayer.Places else AtlasLayer.Sources

fun placeMarkerDetail(place: AtlasPlace): String {
    val total = place.scrolls.total
    return "${place.scrolls.seen} of $total ${if (total == 1) "Scroll" else "Scrolls"} read"
}

/** Empty for a sighting: the wire contract already refuses attention on something unshown. */
fun placeMarkerStatus(place: AtlasPlace): String = place.attention?.state?.uppercase() ?: ""

/** The system-level markers for live planets, in `SpatialAtlas`'s existing marker shape. */
fun planetMarkersOf(places: List<AtlasPlace>): List<AtlasMarker> =
    places.filter { it.kind == "planet" }
        .map { AtlasMarker(it.placeId, it.anchor.name, placeMarkerDetail(it), placeMarkerStatus(it)) }

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
    return regions.mapNotNull { r -> points[r.placeId]?.let { p -> AtlasRegionArea(r.placeId, r.anchor.name, p.x, p.y) } }
}

/** ADR-0036's Cartographer wording (`packages/core/src/atlas/chronicle.ts`'s `VERB` table),
 * mirrored so a sighting's own basis (already name-resolved on the wire) reads the same way. */
internal val ATLAS_RELATION_VERB: Map<String, String> = mapOf(
    "explains" to "explains", "prerequisite_for" to "comes before", "contradicts" to "is in tension with",
    "analogous_in" to "works like", "applies_to" to "applies to", "compares_mechanism" to "can be compared with",
)

/** "Gravity explains Star formation" -- from the sighting's own basis, already resolved to names. */
fun basisSentence(basis: AtlasBasis): String = "${basis.from} ${ATLAS_RELATION_VERB.getValue(basis.kind)} ${basis.to}"

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
        val families = (account?.get("sourceFamilies") as? Number)?.toInt()
        if (episodes != null && days != null && families != null)
            "Formed from $episodes reading${if (episodes == 1) "" else "s"} across $days day${if (days == 1) "" else "s"}" +
                " and $families source famil${if (families == 1) "y" else "ies"}."
        else "Formed from your reading."
    }
    "sighting_appeared" -> {
        val relation = delta.evidence["relation"] as? Map<*, *>
        val verb = (relation?.get("kind") as? String)?.let(ATLAS_RELATION_VERB::get)
        val support = delta.evidence["relationSupport"] as? Map<*, *>
        val claim = support?.get("claim") as? Map<*, *>
        val bridge = support?.get("bridge") as? Map<*, *>
        val claimText = (claim?.get("text") as? String)?.let { text -> "\"$text\" — ${claim["sourceTitle"]}" }
        val supportText = claimText ?: (bridge?.get("mechanism") as? String)
        listOfNotNull(verb?.let { "A connection that $it." }, supportText).joinToString(" ").ifBlank { "A neighbouring idea." }
    }
    // #134 review 2: a sighting the reader came across retires as their own exploration -- the
    // server's evidence names what happened (`evidence.met`), so "no longer active" would be false.
    "sighting_retired" -> when (delta.causalClass) {
        "source_correction" -> "The source behind this connection changed."
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
    else -> "This place changed."
}

enum class RejectPlaceConflict { StaleEpoch, Paused }

/** A 409 from `POST /v1/atlas/places/:placeId/reject` is either a stale privacy epoch (reconcile,
 * same as every other mutation) or recording being paused (an honest message; nothing to reconcile
 * since nothing personal was recorded) -- mirrors `ui/branch/BranchPresentation.kt`'s
 * `branchOpenConflict`. Review M6: matches the server's own two 409 reasons explicitly ("Privacy
 * epoch changed" and "Recording is paused" -- `apps/api/src/atlas-routes.ts`); any other 409 (not
 * a reason this endpoint is known to send) returns `null`, so the caller falls back to a generic
 * message rather than assuming it must mean paused. */
fun rejectPlaceConflict(error: ApiException.Server): RejectPlaceConflict? {
    if (error.statusCode != 409) return null
    val body = error.message ?: ""
    return when {
        body.contains("privacy epoch", ignoreCase = true) -> RejectPlaceConflict.StaleEpoch
        body.contains("paused", ignoreCase = true) -> RejectPlaceConflict.Paused
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
            rows += PlaceListRow(p.placeId, p.kind, p.anchor.name, depth, if (p.kind == "sighting") "Sighting" else placeMarkerDetail(p))
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

/** "$N PLACES · $M SIGHTINGS" -- Places' own subtitle, a straight count of the live atlas, never
 * the Sources subtitle's world/Scroll counts (review M2: the two layers show different data). */
fun placesSubtitle(places: List<AtlasPlace>): String {
    val liveCount = places.count { it.kind == "planet" || it.kind == "region" }
    val sightingCount = places.count { it.kind == "sighting" }
    val placeWord = if (liveCount == 1) "PLACE" else "PLACES"
    val sightingWord = if (sightingCount == 1) "SIGHTING" else "SIGHTINGS"
    return "$liveCount $placeWord · $sightingCount $sightingWord"
}
