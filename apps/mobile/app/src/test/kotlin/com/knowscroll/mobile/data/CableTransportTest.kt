package com.knowscroll.mobile.data

import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CableTransportTest {
    @Test
    fun eachModeUsesTheExistingSingleKindFeed() = runBlocking {
        ServerSocket(0).use { server ->
            val paths = java.util.Collections.synchronizedList(mutableListOf<String>())
            val worker = thread {
                repeat(2) {
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        paths += input.readLine()
                        while (!input.readLine().isNullOrEmpty()) {}
                        val body =
                            """{"decisionId":"d","universeId":"u","accountRevision":0,"privacyEpoch":1,"items":[]}"""
                        socket
                            .getOutputStream()
                            .write(
                                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n" +
                                        body)
                                    .toByteArray()
                            )
                    }
                }
            }
            val api = ApiClient("http://127.0.0.1:${server.localPort}", "fixture-token")
            assertTrue(api.getFeed("Scroll").items.isEmpty())
            assertTrue(api.getFeed("Reel").items.isEmpty())
            worker.join(3000)
            assertEquals(
                listOf("GET /v1/feed?kinds=Scroll HTTP/1.1", "GET /v1/feed?kinds=Reel HTTP/1.1"),
                paths,
            )
        }
    }

    @Test
    fun rapidToggleCancellationDoesNotWaitForAStalledResponse() = runBlocking {
        ServerSocket(0).use { server ->
            val received = CountDownLatch(1)
            val release = CountDownLatch(1)
            val worker = thread {
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    while (!input.readLine().isNullOrEmpty()) {}
                    received.countDown()
                    release.await(5, TimeUnit.SECONDS)
                }
            }
            try {
                val api =
                    ApiClient(
                        "http://127.0.0.1:${server.localPort}",
                        "fixture-token",
                        readTimeoutMs = 8000,
                    )
                val request = launch(Dispatchers.Default) { api.getFeed("Reel") }
                assertTrue(withContext(Dispatchers.IO) { received.await(3, TimeUnit.SECONDS) })
                withTimeout(1500) { request.cancelAndJoin() }
                assertTrue(request.isCancelled)
            } finally {
                release.countDown()
                worker.join(3000)
            }
        }
    }
}
