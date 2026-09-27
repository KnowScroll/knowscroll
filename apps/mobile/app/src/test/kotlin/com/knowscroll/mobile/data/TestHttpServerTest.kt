package com.knowscroll.mobile.data

import java.net.Socket
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #177: the fixture reads a request body whole, however it arrives. A body read in one call could
 * stop at its first segment; the unread rest then made closing the socket send a reset, and a
 * client under load saw "Connection reset" instead of the fixture's answer.
 */
class TestHttpServerTest {
    @Test
    fun aBodyArrivingInTwoSegmentsIsRecordedWhole() {
        TestHttpServer.open().use { server ->
            server.serve(200 to "{}")
            val body = """{"kind":"place","placeId":"11111111-1111-4111-8111-111111111111"}"""
            val port = server.baseUrl.substringAfterLast(":").toInt()
            Socket("127.0.0.1", port).use { socket ->
                val out = socket.getOutputStream()
                out.write("POST /v1/relics HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body.take(10)}".toByteArray())
                out.flush()
                Thread.sleep(200)
                out.write(body.drop(10).toByteArray())
                out.flush()
                socket.getInputStream().readBytes()
            }
            server.join()
            assertEquals(body, server.requests.single().body)
        }
    }
}
