package com.knowscroll.mobile.ui

import com.knowscroll.mobile.data.ApiException
import com.knowscroll.mobile.data.FeedResponse
import com.knowscroll.mobile.data.ScrollItem

/** Next discovery is separate from the currently authorized reading session. */
sealed interface DiscoveryState {
    data object Idle : DiscoveryState
    data object Loading : DiscoveryState
    data object Failed : DiscoveryState
    data object Exhausted : DiscoveryState
}

sealed interface DiscoverySelection {
    data class Item(val item: ScrollItem) : DiscoverySelection
    data object Exhausted : DiscoverySelection
    data object InvalidScope : DiscoverySelection
    /** The Scroll the reader asked for from its place is no longer offered (read, or withdrawn meanwhile). */
    data object PreferredGone : DiscoverySelection
}

/** Check scope even for an empty feed: exhaustion must not hide invalid authority. #164: a Scroll the
 * reader asked for from its place ([preferredAssetId]) is taken when the feed offers it, and nothing
 * else is opened in its name when it does not. */
internal fun selectDiscovery(
    feed: FeedResponse,
    universeId: String,
    privacyEpoch: Long,
    visited: Set<String>,
    currentAssetId: String?,
    preferredAssetId: String? = null,
): DiscoverySelection {
    if (feed.universeId != universeId || feed.privacyEpoch != privacyEpoch) {
        return DiscoverySelection.InvalidScope
    }
    val open = feed.items.filter { it.assetId !in visited && it.assetId != currentAssetId }
    if (preferredAssetId != null) return open.firstOrNull { it.assetId == preferredAssetId }?.let { DiscoverySelection.Item(it) } ?: DiscoverySelection.PreferredGone
    return open.firstOrNull()?.let { DiscoverySelection.Item(it) } ?: DiscoverySelection.Exhausted
}

/** What this discovery trip has opened, as sent to the feed: the current Scroll last, at most 256. */
internal fun tripExclude(visited: Collection<String>, currentAssetId: String?): List<String> =
    (visited.filter { it != currentAssetId } + listOfNotNull(currentAssetId)).takeLast(256)

internal fun canRequestDiscovery(keep: KeepState, discovery: DiscoveryState): Boolean =
    discovery !is DiscoveryState.Loading && keep !is KeepState.Saving &&
        keep !is KeepState.Failed && keep !is KeepState.Conflict

internal fun invalidatesReader(error: Exception): Boolean =
    error is ApiException.MissingToken ||
        error is ApiException.Server && error.statusCode in setOf(401, 409, 422)
