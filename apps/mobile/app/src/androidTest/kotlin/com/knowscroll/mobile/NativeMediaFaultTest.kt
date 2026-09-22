package com.knowscroll.mobile

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.knowscroll.mobile.ui.reel.ReelPlayer
import com.knowscroll.mobile.ui.theme.KnowScrollTheme
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real MP4 decoding with deliberately faulty loopback HTTP. No application API success is faked.
 */
@RunWith(AndroidJUnit4::class)
class NativeMediaFaultTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun bufferingRetryRedirectAndRelease() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "com.knowscroll.mobile.journey")
        val bytes = File(context.filesDir, "native-video.mp4").readBytes()
        val server = ServerSocket(0)
        val pool = Executors.newCachedThreadPool()
        val mode = AtomicInteger(503)
        val frames = AtomicInteger(0)
        val requests = AtomicInteger(0)
        val redirected = AtomicInteger(0)
        pool.execute {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                pool.execute {
                    socket.use { client ->
                        runCatching {
                            val input = client.getInputStream().bufferedReader()
                            val path = input.readLine().split(' ')[1]
                            val headers = mutableMapOf<String, String>()
                            while (true) {
                                val line = input.readLine() ?: break
                                if (line.isEmpty()) break
                                headers[line.substringBefore(':').lowercase()] =
                                    line.substringAfter(':').trim()
                            }
                            requests.incrementAndGet()
                            if (path.startsWith("/steal")) redirected.incrementAndGet()
                            val response = client.getOutputStream()
                            when (mode.get()) {
                                503 ->
                                    response.write(
                                        "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                            .toByteArray()
                                    )
                                302 ->
                                    response.write(
                                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${server.localPort}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                            .toByteArray()
                                    )
                                else -> {
                                    if (mode.get() == 1) Thread.sleep(1200)
                                    val start =
                                        headers["range"]
                                            ?.substringAfter("bytes=")
                                            ?.substringBefore('-')
                                            ?.toIntOrNull() ?: 0
                                    val status =
                                        if (headers.containsKey("range")) "206 Partial Content"
                                        else "200 OK"
                                    response.write(
                                        "HTTP/1.1 $status\r\nContent-Type: video/mp4\r\nContent-Length: ${bytes.size-start}\r\nContent-Range: bytes $start-${bytes.lastIndex}/${bytes.size}\r\nConnection: close\r\n\r\n"
                                            .toByteArray()
                                    )
                                    response.write(bytes, start, bytes.size - start)
                                }
                            }
                            response.flush()
                        }
                    }
                }
            }
        }
        var url by mutableStateOf("http://127.0.0.1:${server.localPort}/video")
        var visible by mutableStateOf(true)
        compose.setContent {
            KnowScrollTheme {
                if (visible)
                    ReelPlayer(
                        url,
                        mapOf("Authorization" to "test-only"),
                        Modifier.fillMaxSize(),
                        onFirstFrame = { frames.incrementAndGet() },
                    )
            }
        }
        fun waitText(text: String) =
            compose.waitUntil(20_000) {
                compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
            }
        try {
            waitText("Retry video")
            assertEquals(0, frames.get())
            mode.set(1)
            compose.onNodeWithText("Retry video").performClick()
            waitText("Buffering video…")
            compose.waitUntil(20_000) { frames.get() > 0 }
            compose.onNodeWithText("Pause").performClick()
            compose.onNodeWithText("Play").assertExists()
            val priorFrames = frames.get()
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            waitText("Play") // user pause survives lifecycle
            compose.onNodeWithText("Play").performClick()
            compose.waitUntil(20_000) { frames.get() > priorFrames }
            waitText("Replay")
            compose.onNodeWithText("Replay").performClick()
            mode.set(302)
            compose.runOnIdle { url = "http://127.0.0.1:${server.localPort}/redirect" }
            waitText("Retry video")
            assertEquals(0, redirected.get())
            mode.set(0)
            repeat(8) { i ->
                compose.runOnIdle { url = "http://127.0.0.1:${server.localPort}/rapid-$i" }
            }
            compose.waitUntil(20_000) {
                compose
                    .onNodeWithContentDescription("Reel video")
                    .fetchSemanticsNode()
                    .config[SemanticsProperties.StateDescription] == "Playing"
            }
            compose.runOnIdle { visible = false }
            compose.waitForIdle()
            val afterClose = requests.get()
            Thread.sleep(1500)
            assertEquals(
                "No continued media requests after player disposal",
                afterClose,
                requests.get(),
            )
            val unavailableUrl = "http://127.0.0.1:${server.localPort}/offline"
            server.close()
            val beforeOffline = frames.get()
            compose.runOnIdle {
                url = unavailableUrl
                visible = true
            }
            waitText("Retry video")
            assertEquals(
                "Connection refusal cannot report a rendered frame",
                beforeOffline,
                frames.get(),
            )
            File(context.filesDir, "media-faults.json")
                .writeText(
                    """{"result":"passed","renderedFramesCallbacks":${frames.get()},"requests":${requests.get()},"redirectRequests":${redirected.get()},"offlineConnectionRefused":true,"slowMedia":true,"retry":true,"pauseRetained":true,"replay":true,"rapidReplacement":true,"closedPlayerStoppedRequests":true,"fixtureOnly":true}"""
                )
        } finally {
            server.close()
            pool.shutdownNow()
        }
    }
}
