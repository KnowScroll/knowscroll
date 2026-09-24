package com.knowscroll.mobile.data

import java.net.ServerSocket
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
    private var worker: Thread? = null

    /** Serves each `(status, jsonBody)` reply, in order, to one accepted connection. */
    fun serve(vararg replies: Pair<Int, String>) {
        worker = thread {
            replies.forEach { (status, body) ->
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    val requestLine = input.readLine() ?: ""
                    var length = 0
                    while (true) {
                        val line = input.readLine()
                        if (line.isNullOrEmpty()) break
                        if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                    }
                    val requestBody = if (length > 0) String(CharArray(length).also { input.read(it, 0, length) }) else ""
                    requests += Recorded(requestLine, requestBody)
                    socket.getOutputStream().write(
                        ("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n" + body)
                            .toByteArray()
                    )
                }
            }
        }
    }

    fun join(timeoutMs: Long = 3000) {
        worker?.join(timeoutMs)
    }

    override fun close() {
        server.close()
    }

    companion object {
        fun open(): TestHttpServer = TestHttpServer(ServerSocket(0))
    }
}
