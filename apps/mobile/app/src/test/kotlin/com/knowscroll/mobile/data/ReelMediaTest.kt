package com.knowscroll.mobile.data

import org.junit.Assert.*
import org.junit.Test

class ReelMediaTest {
    @Test
    fun rejectsRemoteAndPathTraversalMedia() {
        for (path in
            listOf(
                "https://example.com/video.mp4",
                "/v1/media/../private",
                "/v1/media/" + "a".repeat(63),
            )) {
            assertThrows(IllegalArgumentException::class.java) {
                ReelMedia(path, 7.0, "352:640", true)
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            ReelMedia("/v1/media/" + "a".repeat(64), Double.NaN, "352:640", true)
        }
    }
}
