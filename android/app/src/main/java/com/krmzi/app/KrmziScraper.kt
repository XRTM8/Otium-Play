package com.krmzi.app

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.Log
import okhttp3.Cache
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern

/**
 * Native scraper used by the Android WebView.
 *
 * All public methods are synchronous and are called from WebView's background
 * request thread (or from our own IO pool). Responses are cached in memory with
 * per-endpoint TTLs, duplicate concurrent requests are coalesced, and the
 * underlying OkHttp client keeps connections alive and uses a small disk cache.
 */
object KrmziScraper {

    private const val TAG = "KrmziScraper"
    private const val ORIGIN = "https://krmzi.org"
    private const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

    private const val DEFAULT_TTL_MS = 5 * 60 * 1000L
    private const val HOME_TTL_MS = 2 * 60 * 1000L
    private const val DETAIL_TTL_MS = 10 * 60 * 1000L
    private const val SEARCH_TTL_MS = 10 * 60 * 1000L
    private const val STREAM_TTL_MS = 45 * 1000L

    private val threadCounter = AtomicInteger(0)
    private val ioPool: ExecutorService = Executors.newFixedThreadPool(4) { runnable ->
        Thread(runnable, "krmzi-io-${threadCounter.incrementAndGet()}").apply {
            isDaemon = true
            priority = Thread.NORM_PRIORITY
        }
    }

    // Keep provider extraction independent of the home/list request pool.
    // A slow mirror must not hold up ordinary app navigation.
    private val streamPool: ExecutorService = Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "krmzi-stream-${threadCounter.incrementAndGet()}").apply {
            isDaemon = true
        }
    }

    @Volatile
    private var initialized = false

    @Volatile
    private var client: OkHttpClient = buildClient(null)

    private data class CacheEntry(val data: String, val timestamp: Long, val ttlMs: Long)

    private val memoryCache = ConcurrentHashMap<String, CacheEntry>()
    private val inFlight = ConcurrentHashMap<String, CompletableFuture<String>>()

    /* ------------------------------------------------------------------ */
    /*  Client lifecycle                                                   */
    /* ------------------------------------------------------------------ */

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            try {
                val cacheDir = File(context.cacheDir, "krmzi_http")
                val diskCache = Cache(cacheDir, 32L * 1024 * 1024)
                client = buildClient(diskCache)
            } catch (e: Exception) {
                Log.w(TAG, "Unable to create HTTP cache: ${e.message}")
            }
            initialized = true
        }
    }

    private fun buildClient(cache: Cache?): OkHttpClient {
        val dispatcher = Dispatcher().apply {
            maxRequests = 16
            maxRequestsPerHost = 8
        }
        return OkHttpClient.Builder()
            .dispatcher(dispatcher)
            .connectionPool(ConnectionPool(8, 5, TimeUnit.MINUTES))
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .apply { if (cache != null) cache(cache) }
            .build()
    }

    /* ------------------------------------------------------------------ */
    /*  Cache                                                              */
    /* ------------------------------------------------------------------ */

    private fun cached(key: String, ttlMs: Long, producer: () -> String): String {
        val now = System.currentTimeMillis()
        memoryCache[key]?.let { entry ->
            if (now - entry.timestamp < entry.ttlMs) return entry.data
            memoryCache.remove(key, entry)
        }

        val running = inFlight[key]
        if (running != null) {
            return await(running, key, producer)
        }

        val future = CompletableFuture<String>()
        val previous = inFlight.putIfAbsent(key, future)
        if (previous != null) {
            return await(previous, key, producer)
        }

        return try {
            val data = producer()
            if (isCacheablePayload(data)) {
                memoryCache[key] = CacheEntry(data, System.currentTimeMillis(), ttlMs)
                trimCache()
            }
            future.complete(data)
            data
        } catch (t: Throwable) {
            future.completeExceptionally(t)
            throw t
        } finally {
            inFlight.remove(key, future)
        }
    }

    private fun await(
        future: CompletableFuture<String>,
        key: String,
        fallback: () -> String
    ): String {
        return try {
            future.get(30, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w(TAG, "Coalesced request failed for $key: ${e.message}")
            fallback()
        }
    }

    private fun isCacheablePayload(data: String): Boolean {
        if (data.isEmpty()) return false
        return try {
            val json = JSONObject(data)
            !json.has("error") && json.optBoolean("isSuccess", true)
        } catch (_: Exception) {
            false
        }
    }

    private fun trimCache() {
        if (memoryCache.size <= 180) return
        val now = System.currentTimeMillis()
        val iterator = memoryCache.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (now - entry.value.timestamp >= entry.value.ttlMs) iterator.remove()
        }
        if (memoryCache.size > 180) {
            memoryCache.entries
                .sortedBy { it.value.timestamp }
                .take(memoryCache.size - 150)
                .forEach { memoryCache.remove(it.key) }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Networking                                                         */
    /* ------------------------------------------------------------------ */

    private fun fetchHtml(url: String): String {
        if (!isKrmziUrl(url)) {
            Log.w(TAG, "Blocked non-krmzi URL: $url")
            return ""
        }
        return try {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "ar,en-US;q=0.9,en;q=0.8")
                .header("Referer", "$ORIGIN/")
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "HTTP error ${response.code} for: $url")
                    return ""
                }
                response.body?.string() ?: ""
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchHtml failed for: $url, error: ${e.message}")
            ""
        }
    }

    /* ------------------------------------------------------------------ */
    /*  URL helpers                                                        */
    /* ------------------------------------------------------------------ */

    private fun isKrmziUrl(raw: String): Boolean {
        return try {
            val uri = Uri.parse(raw)
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            (scheme == "https" || scheme == "http") &&
                (host == "krmzi.org" || host == "www.krmzi.org")
        } catch (_: Exception) {
            false
        }
    }

    /** Unwrap ad-shortener URLs such as sayyarh.com?url=aHR0cHM6... */
    fun extractRealUrl(rawUrl: String): String {
        if (rawUrl.isEmpty()) return ""
        if (rawUrl.contains("krmzi.org/episode/") || rawUrl.contains("krmzi.org/series/")) {
            return rawUrl
        }

        val matcher = WRAPPER_PATTERN.matcher(rawUrl)
        if (matcher.find()) {
            try {
                var value = URLDecoder.decode(matcher.group(1) ?: "", "UTF-8")
                if (!value.startsWith("http")) {
                    val decoded = decodeBase64(value)
                    if (decoded != null && decoded.contains("krmzi.org")) {
                        return URLDecoder.decode(decoded, "UTF-8")
                    }
                }
                if (value.contains("krmzi.org")) {
                    return value
                }
            } catch (_: Exception) {
                /* ignore malformed wrappers */
            }
        }
        return rawUrl
    }

    private fun decodeBase64(value: String): String? {
        val candidates = intArrayOf(Base64.DEFAULT, Base64.URL_SAFE or Base64.NO_WRAP)
        for (flags in candidates) {
            try {
                val text = String(Base64.decode(value, flags), Charsets.UTF_8)
                if (text.isNotBlank()) return text
            } catch (_: Exception) {
                /* try the next decoder */
            }
        }
        return null
    }

    /* ------------------------------------------------------------------ */
    /*  HTML helpers                                                       */
    /* ------------------------------------------------------------------ */

    private fun decodeHtml(text: String): String {
        return text
            .replace("&quot;", "\"")
            .replace("&#039;", "'")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
    }

    private fun stripTags(html: String): String {
        val withoutTags = TAG_PATTERN.matcher(html).replaceAll(" ")
        return WHITESPACE_PATTERN.matcher(decodeHtml(withoutTags)).replaceAll(" ").trim()
    }

    private fun cleanTitle(title: String): String {
        return stripTags(title).replace(TITLE_SUFFIX, "").trim()
    }

    private fun extractTitle(html: String): String {
        val matcher = TITLE_PATTERN.matcher(html)
        return if (matcher.find()) cleanTitle(matcher.group(1) ?: "") else ""
    }

    private fun extractPoster(html: String): String {
        val matcher = POSTER_PATTERN.matcher(html)
        if (matcher.find()) return decodeHtml(matcher.group(1) ?: "").trim()
        val ogMatcher = OG_IMAGE_PATTERN.matcher(html)
        return if (ogMatcher.find()) decodeHtml(ogMatcher.group(1) ?: "").trim() else ""
    }

    private fun parseCards(html: String, kind: String): JSONArray {
        val items = JSONArray()
        if (html.isEmpty()) return items

        val blockMatcher = BLOCK_PATTERN.matcher(html)
        while (blockMatcher.find()) {
            val block = blockMatcher.group(1) ?: continue
            val linkMatcher =
                if (kind == "series") SERIES_LINK_PATTERN.matcher(block)
                else LINK_PATTERN.matcher(block)
            if (!linkMatcher.find()) continue

            val itemUrl = extractRealUrl(linkMatcher.group(1) ?: "")
            if (!isKrmziUrl(itemUrl)) continue
            if (kind == "search" &&
                !itemUrl.contains("/series/") &&
                !itemUrl.contains("/episode/")
            ) {
                continue
            }

            val title = cleanTitle(linkMatcher.group(2) ?: "")
            val thumbMatcher = THUMB_PATTERN.matcher(block)
            val thumbnail = if (thumbMatcher.find()) decodeHtml(thumbMatcher.group(1) ?: "") else ""

            if (kind == "series") {
                items.put(JSONObject().apply {
                    put("url", itemUrl)
                    put("title", title)
                    put("thumbnail", thumbnail)
                })
                continue
            }

            val numMatcher = EPISODE_NUM_PATTERN.matcher(block)
            val episodeNum = if (numMatcher.find()) numMatcher.group(1) ?: "" else ""
            val seriesTitle =
                if (episodeNum.isNotEmpty()) title.replace(TITLE_EPISODE_TAIL, "").trim()
                else title

            items.put(JSONObject().apply {
                put("url", itemUrl)
                put("title", title)
                put("seriesTitle", seriesTitle.ifEmpty { title })
                put("episodeNum", episodeNum)
                put("thumbnail", thumbnail)
                if (kind == "search") {
                    put("type", if (itemUrl.contains("/series/")) "series" else "episode")
                }
            })
        }
        return items
    }

    /* ------------------------------------------------------------------ */
    /*  Public API                                                         */
    /* ------------------------------------------------------------------ */

    fun handle(fullUrl: String): String {
        return try {
            val uri = Uri.parse(fullUrl)
            val path = uri.path ?: ""

            when {
                path.endsWith("/api/home") -> {
                    val page = uri.getQueryParameter("page")?.toIntOrNull() ?: 1
                    getHome(page)
                }
                path.contains("/api/episodes") -> {
                    val page = uri.getQueryParameter("page")?.toIntOrNull() ?: 1
                    getEpisodes(page)
                }
                path.contains("/api/series/detail") -> {
                    val url = uri.getQueryParameter("url") ?: ""
                    getSeriesDetail(url)
                }
                path.contains("/api/series") -> {
                    val page = uri.getQueryParameter("page")?.toIntOrNull() ?: 1
                    getSeries(page)
                }
                path.contains("/api/search") -> {
                    val q = uri.getQueryParameter("q") ?: ""
                    getSearch(q)
                }
                path.contains("/api/episode/detail") -> {
                    val url = uri.getQueryParameter("url") ?: ""
                    getEpisodeDetail(url, uri.getQueryParameter("fresh") == "1")
                }
                path.contains("/api/health") -> getHealth()
                else -> errorJson("Unknown endpoint: $path")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error in handle: ${e.message}", e)
            errorJson(e.message ?: "Unknown error")
        }
    }

    fun getHome(page: Int): String {
        val safePage = page.coerceAtLeast(1)
        return cached("home_$safePage", HOME_TTL_MS) {
            val episodesFuture = CompletableFuture.supplyAsync({
                JSONObject(getEpisodes(safePage))
            }, ioPool)
            val seriesFuture = CompletableFuture.supplyAsync({
                JSONObject(getSeries(safePage))
            }, ioPool)

            val episodes = try {
                episodesFuture.get(25, TimeUnit.SECONDS)
            } catch (e: Exception) {
                episodesFuture.cancel(true)
                JSONObject().put("page", safePage).put("episodes", JSONArray()).put("hasNext", false)
            }
            val series = try {
                seriesFuture.get(25, TimeUnit.SECONDS)
            } catch (e: Exception) {
                seriesFuture.cancel(true)
                JSONObject().put("page", safePage).put("series", JSONArray()).put("hasNext", false)
            }

            JSONObject().apply {
                put("episodes", episodes)
                put("series", series)
                put("fetchedAt", System.currentTimeMillis())
                put("isSuccess", true)
            }.toString()
        }
    }

    fun getEpisodes(page: Int): String {
        val safePage = page.coerceAtLeast(1)
        return cached("episodes_$safePage", DEFAULT_TTL_MS) {
            val url = if (safePage == 1) "$ORIGIN/" else "$ORIGIN/page/$safePage/"
            val html = fetchHtml(url)
            val episodes = parseCards(html, "episodes")
            val hasNext = html.contains("page/${safePage + 1}/")

            JSONObject().apply {
                put("page", safePage)
                put("episodes", episodes)
                put("hasNext", hasNext)
                put("isSuccess", episodes.length() > 0)
            }.toString()
        }
    }

    fun getSeries(page: Int): String {
        val safePage = page.coerceAtLeast(1)
        return cached("series_$safePage", DEFAULT_TTL_MS) {
            val url =
                if (safePage == 1) "$ORIGIN/series-list/"
                else "$ORIGIN/series-list/page/$safePage/"
            val html = fetchHtml(url)
            val series = parseCards(html, "series")
            val hasNext = html.contains("series-list/page/${safePage + 1}/")

            JSONObject().apply {
                put("page", safePage)
                put("series", series)
                put("hasNext", hasNext)
                put("isSuccess", series.length() > 0)
            }.toString()
        }
    }

    fun getSeriesDetail(url: String): String {
        if (!isKrmziUrl(url)) return errorJson("Invalid series URL")
        return cached("series_detail_${url.hashCode()}", DETAIL_TTL_MS) {
            val html = fetchHtml(url)
            val title = extractTitle(html)
            val poster = extractPoster(html)
            val storyMatcher = STORY_PATTERN.matcher(html)
            val story =
                if (storyMatcher.find()) stripTags(storyMatcher.group(1) ?: "") else ""

            val episodes = JSONArray()
            val seen = mutableSetOf<String>()
            val anchorMatcher = ANCHOR_PATTERN.matcher(html)
            while (anchorMatcher.find()) {
                val epUrl = extractRealUrl(anchorMatcher.group(1) ?: "")
                if (!epUrl.contains("/episode/") || !isKrmziUrl(epUrl)) continue
                if (!seen.add(epUrl)) continue

                val inner = stripTags(anchorMatcher.group(2) ?: "")
                val numMatch = EPISODE_URL_NUM.find(epUrl)
                val epNum = numMatch?.groupValues?.get(1) ?: ""

                episodes.put(JSONObject().apply {
                    put("url", epUrl)
                    put("title", inner.ifEmpty { "الحلقة $epNum" })
                    put("episodeNum", epNum)
                })
            }

            JSONObject().apply {
                put("url", url)
                put("title", title)
                put("poster", poster)
                put("story", story)
                put("episodes", episodes)
                put("isSuccess", true)
            }.toString()
        }
    }

    fun getSearch(query: String): String {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) {
            return JSONObject().apply {
                put("query", "")
                put("results", JSONArray())
                put("isSuccess", true)
            }.toString()
        }

        return cached("search_${trimmed.lowercase()}", SEARCH_TTL_MS) {
            val searchUrl = "$ORIGIN/?s=" + URLEncoder.encode(trimmed, "UTF-8")
            val html = fetchHtml(searchUrl)
            val results = parseCards(html, "search")

            JSONObject().apply {
                put("query", trimmed)
                put("results", results)
                put("isSuccess", true)
            }.toString()
        }
    }

    fun getEpisodeDetail(epUrl: String, forceRefresh: Boolean = false): String {
        if (!isKrmziUrl(epUrl)) return errorJson("Invalid episode URL")
        val cacheKey = "ep_detail_${epUrl.hashCode()}"
        if (forceRefresh) memoryCache.remove(cacheKey)
        return cached(cacheKey, STREAM_TTL_MS) {
            val html = fetchHtml(epUrl)
            if (html.isBlank()) return@cached errorJson("Unable to load episode")
            val title = extractTitle(html)
            val episodeNum = EPISODE_URL_NUM.find(epUrl)?.groupValues?.get(1) ?: ""
            val poster = extractPoster(html)

            val seriesMatcher = SERIES_HREF_PATTERN.matcher(html)
            val seriesUrl = if (seriesMatcher.find()) seriesMatcher.group(1) ?: "" else ""

            val rawServerList = mutableListOf<Pair<String, String>>()
            val seenServerIds = mutableSetOf<String>()

            // 1. Modern Qesen Base64 payload (used by virtually every episode).
            val qesenMatcher = QESEN_PATTERN.matcher(html)
            if (qesenMatcher.find()) {
                try {
                    val decoded = decodeBase64(qesenMatcher.group(1) ?: "")
                    if (decoded != null) {
                        val postObj = JSONObject(decoded)
                        val rawServers = postObj.optJSONArray("servers") ?: JSONArray()
                        for (i in 0 until rawServers.length()) {
                            val server = rawServers.optJSONObject(i) ?: continue
                            val name = server.optString("name", "").trim()
                            val id = server.optString("id", "").trim()
                            if (name.isNotEmpty() && id.isNotEmpty() && seenServerIds.add(id)) {
                                rawServerList.add(Pair(name, id))
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Failed parsing Qesen payload: ${e.message}")
                }
            }

            // 2. Legacy <li data-name data-server> markup.
            val liMatcher = LEGACY_SERVER_PATTERN.matcher(html)
            while (liMatcher.find()) {
                val name = (liMatcher.group(1) ?: "").trim()
                val id = (liMatcher.group(2) ?: "").trim()
                if (name.isNotEmpty() && id.isNotEmpty() && seenServerIds.add(id)) {
                    rawServerList.add(Pair(name, id))
                }
            }

            // 3. Last resort: a direct iframe on the page.
            if (rawServerList.isEmpty()) {
                val iframeMatcher = IFRAME_PATTERN.matcher(html)
                if (iframeMatcher.find()) {
                    val iframeUrl = iframeMatcher.group(1) ?: ""
                    if (iframeUrl.isNotEmpty()) {
                        rawServerList.add(Pair("سيرفر رئيسي", iframeUrl))
                    }
                }
            }

            // Resolve in parallel but return as soon as ONE mirror is usable.
            // A shared deadline bounds the whole operation, including queueing.
            val okServers = rawServerList.filter { it.first.equals("ok", ignoreCase = true) }
            val okStreams = ConcurrentHashMap<String, JSONArray>()
            if (okServers.isNotEmpty()) {
                val providerCalls = Collections.synchronizedList(mutableListOf<Call>())
                val completions = ExecutorCompletionService<Pair<String, JSONArray>>(streamPool)
                val futures = okServers.take(3).map { (_, id) ->
                    completions.submit(java.util.concurrent.Callable {
                        val streams = JSONArray()
                        extractOkDirectStreams(id, streams, providerCalls)
                        Pair(id, streams)
                    })
                }
                val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(6_500)
                try {
                    for (ignored in futures.indices) {
                        val remaining = deadline - System.nanoTime()
                        if (remaining <= 0) break
                        val finished = completions.poll(remaining, TimeUnit.NANOSECONDS) ?: break
                        val (id, streams) = finished.get()
                        if (streams.length() > 0) {
                            okStreams[id] = streams
                            break
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "OK.ru extraction stopped: ${e.message}")
                } finally {
                    futures.forEach { if (!it.isDone) it.cancel(true) }
                    synchronized(providerCalls) {
                        providerCalls.forEach { it.cancel() }
                        providerCalls.clear()
                    }
                }
            }

            val directStreams = JSONArray()
            val seenStreamUrls = mutableSetOf<String>()
            val directServers = mutableListOf<JSONObject>()
            val otherServers = mutableListOf<JSONObject>()

            for ((name, id) in rawServerList) {
                val isDirect =
                    name.equals("ok", ignoreCase = true) && okStreams.containsKey(id)

                if (isDirect) {
                    val streams = okStreams[id]
                    if (streams != null) {
                        for (i in 0 until streams.length()) {
                            val stream = streams.optJSONObject(i) ?: continue
                            val streamUrl = stream.optString("url", "")
                            if (streamUrl.isNotEmpty() && seenStreamUrls.add(streamUrl)) {
                                directStreams.put(stream)
                            }
                        }
                    }
                }

                val embedUrl = buildEmbedUrl(name, id)
                if (embedUrl.isEmpty()) continue

                val serverObj = JSONObject().apply {
                    put("name", name)
                    put("id", id)
                    put("embedUrl", embedUrl)
                    put("hasDirectStream", isDirect)
                }
                if (isDirect) directServers.add(serverObj) else otherServers.add(serverObj)
            }

            val servers = JSONArray()
            directServers.forEach { servers.put(it) }
            otherServers.forEach { servers.put(it) }

            JSONObject().apply {
                put("url", epUrl)
                put("title", title)
                put("episodeNum", episodeNum)
                put("poster", poster)
                put("seriesUrl", seriesUrl)
                put("servers", servers)
                put("directStreams", directStreams)
                put("isSuccess", true)
            }.toString()
        }
    }

    fun getHealth(): String {
        return JSONObject().apply {
            put("ok", true)
            put("native", true)
            put("initialized", initialized)
            put("cacheEntries", memoryCache.size)
            put("inFlight", inFlight.size)
            put("time", System.currentTimeMillis())
        }.toString()
    }

    /** Drop expired entries; called when Android reports memory pressure. */
    fun trimMemory() {
        val now = System.currentTimeMillis()
        val iterator = memoryCache.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (now - entry.value.timestamp >= entry.value.ttlMs) iterator.remove()
        }
        if (memoryCache.size > 60) {
            memoryCache.entries
                .sortedBy { it.value.timestamp }
                .take(memoryCache.size - 40)
                .forEach { memoryCache.remove(it.key) }
        }
    }

    /** Drop every in-memory response; the disk/HTTP cache is left intact. */
    fun clearMemoryCache() {
        memoryCache.clear()
    }

    /* ------------------------------------------------------------------ */
    /*  Providers                                                          */
    /* ------------------------------------------------------------------ */

    private fun buildEmbedUrl(name: String, id: String): String {
        return when (name.lowercase()) {
            "ok" -> "https://ok.ru/videoembed/$id"
            "arab hd" -> "https://arabhd.onl/embed-$id.html"
            "estream" -> "https://arabveturk.com/embed-$id.html"
            "red hd" -> "https://iplayerhls.com/e/$id"
            "box" -> "https://youdboox.com/embed-$id.html"
            "now" -> "https://extreamnow.org/embed-$id.html"
            "pro hd" -> "https://embedo.co/e/$id"
            "dailymotion" -> "https://www.dailymotion.com/embed/video/$id"
            "youtube" -> "https://www.youtube.com/embed/$id"
            "express" -> if (id.startsWith("http")) id else "https://cloud.mail.ru/public/$id"
            else -> if (id.startsWith("http")) id else ""
        }
    }

    private fun extractOkDirectStreams(
        sId: String,
        directStreams: JSONArray,
        providerCalls: MutableList<Call>
    ): Boolean {
        return try {
            val request = Request.Builder()
                .url("https://ok.ru/videoembed/$sId")
                .header("User-Agent", USER_AGENT)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "ar,en-US;q=0.9,en;q=0.8")
                .build()

            val providerClient = client.newBuilder()
                .connectTimeout(4, TimeUnit.SECONDS)
                .readTimeout(6, TimeUnit.SECONDS)
                .callTimeout(6, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false)
                .build()
            val providerCall = providerClient.newCall(request)
            synchronized(providerCalls) {
                if (Thread.currentThread().isInterrupted) return false
                providerCalls.add(providerCall)
            }
            val okHtml = try {
                providerCall.execute().use { response ->
                    if (response.isSuccessful) response.body?.string() ?: "" else ""
                }
            } finally {
                providerCalls.remove(providerCall)
            }
            if (okHtml.isEmpty()) return false

            val optionsMatcher = OK_OPTIONS_PATTERN.matcher(okHtml)
            if (!optionsMatcher.find()) return false

            val raw = decodeHtml(optionsMatcher.group(1) ?: "").replace("&quot;", "\"")
            val okData = JSONObject(raw)
            val flashvars = okData.optJSONObject("flashvars") ?: return false
            val metadataValue = flashvars.opt("metadata")
            val metadata =
                when (metadataValue) {
                    is JSONObject -> metadataValue
                    is String -> JSONObject(metadataValue)
                    else -> null
                } ?: return false

            val hlsManifestUrl = metadata.optString("hlsManifestUrl", "")
            if (hlsManifestUrl.startsWith("https://") || hlsManifestUrl.startsWith("http://")) {
                directStreams.put(JSONObject().apply {
                    put("quality", "تلقائي")
                    put("type", "hls")
                    put("url", hlsManifestUrl)
                })
            }
            val videos = metadata.optJSONArray("videos") ?: return directStreams.length() > 0
            if (videos.length() == 0) return directStreams.length() > 0

            val videoList = ArrayList<JSONObject>(videos.length())
            for (i in 0 until videos.length()) {
                videos.optJSONObject(i)?.let { videoList.add(it) }
            }

            val seen = mutableSetOf<String>()
            for (quality in OK_QUALITY_ORDER) {
                val match = videoList.firstOrNull { it.optString("name") == quality } ?: continue
                val url = match.optString("url", "")
                if (url.isEmpty() || !seen.add(url)) continue
                directStreams.put(JSONObject().apply {
                    put("quality", OK_QUALITY_LABELS[quality] ?: quality)
                    put("url", url)
                })
            }
            directStreams.length() > 0
        } catch (e: Exception) {
            Log.w(TAG, "Failed OK.ru extract for $sId: ${e.message}")
            false
        }
    }

    private fun safeMediaUrl(raw: String): java.net.URI? = try {
        val uri = java.net.URI(raw)
        val host = uri.host?.lowercase() ?: ""
        if (uri.scheme == "https" && uri.userInfo == null && (uri.port == -1 || uri.port == 443) &&
            listOf("okcdn.ru", "vkuser.net").any { host == it || host.endsWith(".$it") }) uri else null
    } catch (_: Exception) { null }

    fun mediaResponse(raw: String, range: String?): android.webkit.WebResourceResponse {
        val error = { android.webkit.WebResourceResponse("text/plain", "UTF-8", 502, "Bad Gateway",
            mutableMapOf("Cache-Control" to "no-store"), "Media unavailable".byteInputStream()) }
        var target = safeMediaUrl(raw) ?: return error()
        val mediaClient = client.newBuilder().followRedirects(false).followSslRedirects(false)
            .callTimeout(20, TimeUnit.SECONDS).build()
        var response: okhttp3.Response? = null
        try {
            for (redirects in 0..5) {
                val request = Request.Builder().url(target.toString())
                    .header("User-Agent", USER_AGENT).header("Origin", "https://ok.ru")
                    .header("Referer", "https://ok.ru/")
                    .apply { if (range != null) header("Range", range) }.build()
                val current = mediaClient.newCall(request).execute()
                response = current
                if (current.code !in 300..399) break
                val next = current.header("Location")?.let { safeMediaUrl(target.resolve(it).toString()) }
                current.close()
                if (next == null || redirects == 5) return error()
                target = next
            }
            val upstream = response ?: return error()
            if (!upstream.isSuccessful) { upstream.close(); return error() }
            val type = upstream.header("Content-Type")?.substringBefore(';') ?: "video/mp2t"
            val headers = mutableMapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*")
            for (name in listOf("Content-Range", "Accept-Ranges")) upstream.header(name)?.let { headers[name] = it }
            if (type.contains("mpegurl", true) || target.path.endsWith(".m3u8")) {
                val text = upstream.use { it.body?.string() ?: "" }
                fun proxy(uri: String): String {
                    val resolved = safeMediaUrl(target.resolve(uri).toString()) ?: throw IllegalArgumentException("Invalid media host")
                    return "/api/media?url=" + URLEncoder.encode(resolved.toString(), "UTF-8")
                }
                val rewritten = text.lines().joinToString("\n") { line ->
                    when {
                        line.isBlank() -> line
                        line.startsWith("#") -> Regex("URI=\"([^\"]+)\"").replace(line) { "URI=\"${proxy(it.groupValues[1])}\"" }
                        else -> proxy(line.trim())
                    }
                }
                return android.webkit.WebResourceResponse("application/vnd.apple.mpegurl", "UTF-8", 200, "OK", headers, rewritten.byteInputStream())
            }
            val body = upstream.body ?: run { upstream.close(); return error() }
            val input = object : java.io.FilterInputStream(body.byteStream()) {
                override fun close() { try { super.close() } finally { upstream.close() } }
            }
            return android.webkit.WebResourceResponse(type, null, upstream.code, if (upstream.code == 206) "Partial Content" else "OK", headers, input)
        } catch (_: Exception) { response?.close(); return error() }
    }

    private fun errorJson(message: String): String =
        JSONObject().put("error", message).toString()

    /* ------------------------------------------------------------------ */
    /*  Precompiled patterns                                               */
    /* ------------------------------------------------------------------ */

    private val BLOCK_PATTERN =
        Pattern.compile("<div class=\"block-post\">([\\s\\S]*?)</div>\\s*</div>")
    private val LINK_PATTERN =
        Pattern.compile("<a\\s+href=\"([^\"]+)\"\\s+title=\"([^\"]+)\"")
    private val SERIES_LINK_PATTERN =
        Pattern.compile("<a\\s+href=\"(https://krmzi\\.org/series/[^\"]+)\"\\s+title=\"([^\"]+)\"")
    private val EPISODE_NUM_PATTERN =
        Pattern.compile("<div class=\"episodeNum\">[\\s\\S]*?<span>(\\d+)</span>")
    private val THUMB_PATTERN =
        Pattern.compile("url\\((https://krmzi\\.org/wp-content/uploads/[^)]+)\\)")
    private val TITLE_PATTERN = Pattern.compile("<h1[^>]*>([\\s\\S]*?)</h1>")
    private val STORY_PATTERN = Pattern.compile("<div class=\"story\">([\\s\\S]*?)</div>")
    private val POSTER_PATTERN =
        Pattern.compile("url\\(['\"]?(https://krmzi\\.org/wp-content/uploads/[^)'\"]+)['\"]?\\)")
    private val OG_IMAGE_PATTERN =
        Pattern.compile("<meta[^>]+property=\"og:image\"[^>]+content=\"([^\"]+)\"")
    private val SERIES_HREF_PATTERN =
        Pattern.compile("<a[^>]+href=\"(https://krmzi\\.org/series/[^\"]+)\"")
    private val ANCHOR_PATTERN = Pattern.compile("<a\\s+href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>")
    private val QESEN_PATTERN =
        Pattern.compile("href=\"https://qesen\\.net/krmzi\\?post=([^\"]+)\"")
    private val LEGACY_SERVER_PATTERN =
        Pattern.compile("<li[^>]*data-name=\"([^\"]*)\"[^>]*data-server=\"([^\"]*)\"")
    private val IFRAME_PATTERN = Pattern.compile("<iframe[^>]+src=\"([^\"]+)\"")
    private val OK_OPTIONS_PATTERN = Pattern.compile("data-options=\"([^\"]+)\"")
    private val WRAPPER_PATTERN = Pattern.compile("[?&](?:url|link|target)=([^&]+)")
    private val TAG_PATTERN = Pattern.compile("<[^>]+>")
    private val WHITESPACE_PATTERN = Pattern.compile("\\s+")
    private val TITLE_SUFFIX = Regex("\\s*-\\s*قرمزي\\s*$")
    private val TITLE_EPISODE_TAIL = Regex("الحلقة\\s*\\d+.*")
    private val EPISODE_URL_NUM = Regex("الحلقة-(\\d+)")

    private val OK_QUALITY_ORDER =
        listOf("full", "hd", "sd", "low", "lowest", "mobile")
    private val OK_QUALITY_LABELS = mapOf(
        "full" to "1080p (Full HD)",
        "hd" to "720p (HD)",
        "sd" to "480p (SD)",
        "low" to "360p",
        "lowest" to "240p",
        "mobile" to "144p"
    )
}
