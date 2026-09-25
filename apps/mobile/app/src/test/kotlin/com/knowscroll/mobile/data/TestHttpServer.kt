package com.knowscroll.mobile.data

import java.io.BufferedReader
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/**
 * A tiny one-reply-per-accepted-connection raw HTTP/1.1 fixture, shared by #135's ApiClient and
 * AccountViewModel tests. Mirrors the exact wire-reading idiom `WhyTest`/`BranchesTest`/
 * `CableTransportTest` already use inline, factored out so each new test does not repeat it.
 */
class TestHttpServer private constructor(private val server: ServerSocket) : AutoCloseable {
    data class Recorded(val requestLine: String, val body: String)

    val baseUrl get() = "http://127.0.0.1:${server.localPort}"
    val requests: MutableList<Recorded> = java.util.Collections.synchronizedList(mutableListOf())
    /** A copy taken under the list's lock: iterating [requests] itself while the server thread appends can throw. */
    fun snapshot(): List<Recorded> = synchronized(requests) { requests.toList() }
    private var worker: Thread? = null
    @Volatile private var held: CountDownLatch? = null

    /**
     * #169: every answer from now on waits for [releaseAnswers] (or [close]), so a test can see the
     * state an action shows while its request is in flight. Otherwise a fast enough answer can finish
     * the whole call before the action returns -- `withContext(Dispatchers.IO)` then never suspends --
     * and that state is never there to see.
     */
    fun holdAnswers() {
        held = CountDownLatch(1)
    }

    fun releaseAnswers() {
        held?.countDown()
    }

    /** Serves each `(status, jsonBody)` reply, in order, to one accepted connection. */
    fun serve(vararg replies: Pair<Int, String>) {
        worker = thread {
            replies.forEach { reply -> answerNext { reply } }
        }
    }

    /** #134: serves [count] connections, each answered by [route] from its own request -- for reads
     * a client sends concurrently, which arrive in no fixed order. */
    fun serveBy(count: Int, route: (Recorded) -> Pair<Int, String>) {
        worker = thread {
            repeat(count) { answerNext(route) }
        }
    }

    private fun answerNext(reply: (Recorded) -> Pair<Int, String>) {
        server.accept().use { socket ->
            val input = socket.getInputStream().bufferedReader()
            val requestLine = input.readLine() ?: ""
            var length = 0
            while (true) {
                val line = input.readLine()
                if (line.isNullOrEmpty()) break
                if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
            }
            val requestBody = input.readBody(length)
            val recorded = Recorded(requestLine, requestBody)
            requests += recorded
            val (status, body) = reply(recorded)
            held?.await()
            if (status == HANG) {
                // Received in full, never answered: hold the connection until the client
                // gives up (its read timeout) and closes it -- a genuinely lost response.
                socket.soTimeout = 15_000
                runCatching { while (input.read() != -1) Unit }
                return@use
            }
            socket.getOutputStream().write(
                ("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n" + body)
                    .toByteArray()
            )
        }
    }

    fun join(timeoutMs: Long = 3000) {
        worker?.join(timeoutMs)
    }

    override fun close() {
        releaseAnswers()
        server.close()
    }

    companion object {
        /** A reply "status" that reads the request and never answers it (see [serve]). */
        const val HANG = -1
        fun open(): TestHttpServer = TestHttpServer(ServerSocket(0))
    }
}

/**
 * A request body of [length] characters, read until it is all in. One read can stop at the first
 * segment, and closing a socket with unread input resets the connection before the client reads
 * the answer (#177). Every raw-HTTP test fixture reads its bodies with this.
 */
internal fun BufferedReader.readBody(length: Int): String {
    val chars = CharArray(length)
    var read = 0
    while (read < length) {
        val n = read(chars, read, length - read)
        if (n < 0) break
        read += n
    }
    return String(chars, 0, read)
}
