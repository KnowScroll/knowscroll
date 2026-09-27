package com.knowscroll.mobile.ui.scroll.content

/** Native allowlist. No HTML, JS, executable games or arbitrary code reaches the renderer. */
sealed interface ScrollBlock {
    data class Prose(val text: String) : ScrollBlock

    data class Heading(val text: String) : ScrollBlock

    data class Image(val url: String, val alt: String, val caption: String) : ScrollBlock

    data class ComparisonSlider(val label: String, val left: String, val right: String) :
        ScrollBlock

    data class Diagram(val label: String, val nodes: List<String>) : ScrollBlock

    data class Unsupported(val type: String) : ScrollBlock
}

data class ScrollDocument(val blocks: List<ScrollBlock>) {
    init {
        require(blocks.size <= 128)
        blocks.filterIsInstance<ScrollBlock.Diagram>().forEach { require(it.nodes.size <= 30) }
    }

    companion object {
        /** Exact body retained: no markdown interpretation, and never a source (#161). */
        fun fromBody(body: String) = ScrollDocument(listOf(ScrollBlock.Prose(body)))
    }
}
