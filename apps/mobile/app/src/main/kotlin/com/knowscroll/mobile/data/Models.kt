package com.knowscroll.mobile.data

data class Universe(
    val universeId: String,
    val revision: Long,
    val privacyEpoch: Long,
    val traces: List<Trace>,
    val capabilities: Capabilities
)

data class Trace(val eventId: String, val assetId: String, val title: String, val createdAt: String)

data class Capabilities(val reasoning: Boolean, val reels: Boolean, val worldEvolution: Boolean) {
    companion object { val AllFalse = Capabilities(false, false, false) }
}

data class FeedResponse(
    val decisionId: String,
    val universeId: String,
    val accountRevision: Long,
    val privacyEpoch: Long,
    val items: List<ScrollItem>
)

data class ScrollItem(
    val assetId: String,
    val revision: Int,
    val kind: String,
    val title: String,
    val summary: String,
    val body: String,
    val sourceTitle: String,
    val sourceUrl: String,
    val truthState: String,
    val reason: String
)

data class ExposureRequest(val decisionId: String, val assetId: String, val clientExposureId: String)
data class ExposureResponse(val exposureId: String, val eventId: String)

data class InteractionRequest(val clientEventId: String, val exposureId: String, val assetId: String, val kind: String)
data class InteractionResponse(val eventId: String, val jobId: String, val status: String)

data class HistoryClearRequest(
    val requestId: String,
    val expectedPrivacyEpoch: Long,
    val confirmation: String = "clear-scroll-history"
)

data class HistoryClearReceipt(val receiptId: String, val privacyEpoch: Long, val clearedAt: String)

data class EventStatus(
    val eventId: String,
    val causationId: String?,
    val exposureId: String?,
    val kind: String,
    val jobId: String?,
    val jobStatus: String?,
    val projected: Boolean
)
