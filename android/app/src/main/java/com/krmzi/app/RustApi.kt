package com.krmzi.app

import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream

/** Platform adapter only. All provider, cache and stream logic lives in Rust. */
object RustApi {
    init { System.loadLibrary("otium_core") }
    external fun request(url: String): String
    external fun open(url: String, range: String): String
    external fun read(handle: Long, size: Int): ByteArray
    external fun close(handle: Long)
    external fun trimMemory()
    external fun clearMemoryCache()

    fun response(url: String, range: String = ""): WebResourceResponse {
        val metadata = JSONObject(open(url, range))
        val handle = metadata.optLong("handle", 0)
        val status = metadata.optInt("status", 502)
        val mime = metadata.optString("mime", "application/octet-stream")
        val headers = mutableMapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store")
        metadata.optJSONObject("headers")?.let { json -> json.keys().forEach { headers[it] = json.optString(it) } }
        val body = if (handle > 0) RustInputStream(handle) else
            metadata.optString("error", "upstream_unavailable").byteInputStream(Charsets.UTF_8)
        return WebResourceResponse(mime.substringBefore(';'), if (mime.contains("json") || mime.contains("mpegurl") || mime.contains("text")) "UTF-8" else null,
            status, if (status in 200..299) "OK" else "Source Error", headers, body)
    }

    private class RustInputStream(private var handle: Long) : InputStream() {
        private var chunk = ByteArray(0)
        private var position = 0
        private var closed = false
        private var ended = false
        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 255
        }
        @Synchronized override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (offset < 0 || length < 0 || length > buffer.size - offset) throw IndexOutOfBoundsException()
            if (length == 0) return 0
            if (ended) return -1
            if (closed) throw IOException("Stream closed")
            if (position >= chunk.size) {
                chunk = RustApi.read(handle, minOf(length, 65536))
                position = 0
                if (chunk.isEmpty()) { ended = true; close(); return -1 }
            }
            val count = minOf(length, chunk.size - position)
            chunk.copyInto(buffer, offset, position, position + count)
            position += count
            return count
        }
        @Synchronized override fun close() {
            if (!closed) { closed = true; RustApi.close(handle); handle = 0; chunk = ByteArray(0) }
        }
    }
}
