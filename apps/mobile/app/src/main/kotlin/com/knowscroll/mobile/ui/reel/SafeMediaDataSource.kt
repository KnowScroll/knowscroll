package com.knowscroll.mobile.ui.reel

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

class MediaHttpException(val status: Int) : IOException("Media request refused")

/** Credentials go only to this exact admitted URL. HTTP redirects are never followed. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class SafeMediaDataSource(
    private val admittedUrl: String,
    private val headers: Map<String, String>,
) : BaseDataSource(true) {
    private var connection: HttpURLConnection? = null
    private var input: InputStream? = null
    private var remaining = C.LENGTH_UNSET.toLong()
    private var started = false

    override fun open(dataSpec: DataSpec): Long {
        require(dataSpec.uri.toString() == admittedUrl)
        val url = URL(admittedUrl)
        require(url.protocol in setOf("http", "https"))
        transferInitializing(dataSpec)
        val conn =
            (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 5000
                readTimeout = 8000
                headers.forEach { (key, value) -> setRequestProperty(key, value) }
                setRequestProperty("Accept-Encoding", "identity")
                if (dataSpec.position > 0 || dataSpec.length != C.LENGTH_UNSET.toLong()) {
                    val end =
                        if (dataSpec.length == C.LENGTH_UNSET.toLong()) ""
                        else (dataSpec.position + dataSpec.length - 1).toString()
                    setRequestProperty("Range", "bytes=${dataSpec.position}-$end")
                }
            }
        connection = conn
        try {
            val status = conn.responseCode
            if (status !in 200..299) throw MediaHttpException(status)
            if (dataSpec.position > 0 && status != 206) throw IOException("Media range unavailable")
            remaining =
                if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length
                else conn.contentLengthLong
            input = conn.inputStream
            started = true
            transferStarted(dataSpec)
            return remaining
        } catch (error: Exception) {
            close()
            throw error
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val limit = if (remaining < 0) length else minOf(length.toLong(), remaining).toInt()
        val count = input?.read(buffer, offset, limit) ?: C.RESULT_END_OF_INPUT
        if (count > 0) {
            if (remaining > 0) remaining -= count
            bytesTransferred(count)
        }
        return count
    }

    override fun getUri(): Uri = Uri.parse(admittedUrl)

    override fun close() {
        try {
            input?.close()
        } finally {
            input = null
            connection?.disconnect()
            connection = null
            if (started) {
                started = false
                transferEnded()
            }
        }
    }
}
