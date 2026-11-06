package com.krmzi.app

import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private companion object {
        const val TAG = "KrmziMainActivity"
        const val APP_URL = "https://appassets.androidplatform.net/assets/public/index.html"
        const val FALLBACK_VERSION_NAME = "2.0.0"
        const val FALLBACK_VERSION_CODE = 15L
    }

    private lateinit var webView: WebView
    private lateinit var container: FrameLayout
    private lateinit var assetLoader: WebViewAssetLoader
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var isVideoPlaying = false
    private var isDestroyed = false
    private var appChromeClient: WebChromeClient? = null

    /* ------------------------------------------------------------------ */
    /*  JavaScript bridge                                                  */
    /* ------------------------------------------------------------------ */

    inner class KrmziBridge {
        @JavascriptInterface
        fun isTelevision(): Boolean = (resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION

        @JavascriptInterface
        fun setVideoPlaying(playing: Boolean) {
            runOnUiThread {
                isVideoPlaying = playing
                try {
                    if (playing) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        hideSystemBars(true)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            setPictureInPictureParams(
                                PictureInPictureParams.Builder()
                                    .setAspectRatio(Rational(16, 9))
                                    .build()
                            )
                        }
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        hideSystemBars(false)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Unable to update playback flags: ${e.message}")
                }
            }
        }

        @JavascriptInterface
        fun setLandscape(enable: Boolean) {
            runOnUiThread {
                try {
                    requestedOrientation = if (enable) {
                        hideSystemBars(true)
                        ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    } else {
                        hideSystemBars(false)
                        if ((resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION) ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Orientation error: ${e.message}")
                }
            }
        }

        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                val info = packageManager.getPackageInfo(packageName, 0)
                val versionName = info.versionName ?: FALLBACK_VERSION_NAME
                val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    info.longVersionCode
                } else {
                    @Suppress("DEPRECATION")
                    info.versionCode.toLong()
                }
                JSONObject().apply {
                    put("versionName", versionName)
                    put("versionCode", versionCode)
                }.toString()
            } catch (_: Exception) {
                """{"versionName":"$FALLBACK_VERSION_NAME","versionCode":$FALLBACK_VERSION_CODE}"""
            }
        }

        @JavascriptInterface
        fun checkForUpdates(): String {
            var connection: HttpURLConnection? = null
            return try {
                val url = URL("https://api.github.com/repos/XRTM8/Otium-Play/releases/latest")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8_000
                    readTimeout = 8_000
                    setRequestProperty("User-Agent", "KrmziApp-Android")
                    setRequestProperty("Accept", "application/vnd.github.v3+json")
                }
                connection = conn
                val code = conn.responseCode
                if (code != 200) {
                    return JSONObject().apply {
                        put("hasUpdate", false)
                        put("error", "HTTP $code")
                        put("isSuccess", false)
                    }.toString()
                }

                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(body)
                val tagName = json.optString("tag_name", "").replace("v", "").trim()
                val releaseName = json.optString("name", "تحديث جديد")
                val releaseNotes = json.optString("body", "")

                var apkUrl = ""
                val assets = json.optJSONArray("assets")
                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val asset = assets.optJSONObject(i) ?: continue
                        val name = asset.optString("name", "")
                        if (name.endsWith(".apk", ignoreCase = true)) {
                            apkUrl = asset.optString("browser_download_url", "")
                            break
                        }
                    }
                }
                if (apkUrl.isEmpty()) {
                    apkUrl = json.optString(
                        "html_url",
                        "https://github.com/XRTM8/Otium-Play/releases/latest"
                    )
                }

                val info = packageManager.getPackageInfo(packageName, 0)
                val currentVersion = (info.versionName ?: FALLBACK_VERSION_NAME)
                    .replace("v", "")
                    .trim()

                JSONObject().apply {
                    put("hasUpdate", isNewerVersion(currentVersion, tagName))
                    put("currentVersion", currentVersion)
                    put("latestVersion", tagName)
                    put("releaseName", releaseName)
                    put("changelog", releaseNotes)
                    put("downloadUrl", apkUrl)
                    put("isSuccess", true)
                }.toString()
            } catch (e: Exception) {
                Log.e(TAG, "Update check error: ${e.message}")
                JSONObject().apply {
                    put("hasUpdate", false)
                    put("error", e.message)
                    put("isSuccess", false)
                }.toString()
            } finally {
                connection?.disconnect()
            }
        }

        @JavascriptInterface
        fun openDownloadUrl(downloadUrl: String) {
            runOnUiThread {
                try {
                    val uri = Uri.parse(downloadUrl)
                    if (uri.scheme != "https" && uri.scheme != "http") return@runOnUiThread
                    startActivity(
                        Intent(Intent.ACTION_VIEW, uri).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to launch download URL: ${e.message}")
                }
            }
        }
    }

    private fun isNewerVersion(current: String, latest: String): Boolean {
        if (latest.isEmpty()) return false
        val currentParts = current.split(".").mapNotNull { it.toIntOrNull() }
        val latestParts = latest.split(".").mapNotNull { it.toIntOrNull() }
        val maxLength = maxOf(currentParts.size, latestParts.size)
        for (i in 0 until maxLength) {
            val c = currentParts.getOrElse(i) { 0 }
            val l = latestParts.getOrElse(i) { 0 }
            if (l > c) return true
            if (l < c) return false
        }
        return false
    }

    /* ------------------------------------------------------------------ */
    /*  Lifecycle                                                          */
    /* ------------------------------------------------------------------ */

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if ((resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        configureWindow()

        container = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#08090f"))
        }

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        createWebView()
        container.addView(webView)
        setContentView(container)

        configureWebView()
        setupBackHandler()
        webView.loadUrl(APP_URL)
    }

    private fun configureWindow() {
        try {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.BLACK
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            window.setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
            )
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

            // Utilize full display under cutout/notch
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                window.attributes.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }

            // Enable 120Hz / 90Hz High Refresh Rate on supported displays
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    display
                } else {
                    @Suppress("DEPRECATION")
                    windowManager.defaultDisplay
                }
                val modes = display?.supportedModes
                val currentMode = display?.mode
                val highestMode = modes?.filter { it.physicalWidth == currentMode?.physicalWidth && it.physicalHeight == currentMode.physicalHeight && it.refreshRate <= 120.5f }?.maxByOrNull { it.refreshRate }
                if (highestMode != null && highestMode.refreshRate > 60f) {
                    val params = window.attributes
                    params.preferredDisplayModeId = highestMode.modeId
                    window.attributes = params
                    Log.d(TAG, "Display set to high refresh rate: ${highestMode.refreshRate}Hz")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Window configuration failed: ${e.message}")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.TRANSPARENT)
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.loadsImagesAutomatically = true
        settings.blockNetworkImage = false
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)
        settings.setGeolocationEnabled(false)
        settings.setNeedInitialFocus(false)
        settings.textZoom = 100
        settings.userAgentString =
            (settings.userAgentString ?: "Mozilla/5.0") + " KrmziApp/$FALLBACK_VERSION_NAME"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.offscreenPreRaster = true
        }

        try {
            val debugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
            WebView.setWebContentsDebuggingEnabled(debugBuild)
        } catch (_: Exception) {
        }

        // Cookies are required by several embedded video providers.
        try {
            val cookieManager = CookieManager.getInstance()
            cookieManager.setAcceptCookie(true)
            cookieManager.setAcceptThirdPartyCookies(webView, true)
        } catch (e: Exception) {
            Log.w(TAG, "Cookie configuration failed: ${e.message}")
        }

        webView.addJavascriptInterface(KrmziBridge(), "KrmziBridge")

        val chromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?
            ): Boolean {
                // Third-party ad networks must never open popups.
                return false
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null) {
                    callback?.onCustomViewHidden()
                    return
                }
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                webView.visibility = View.GONE
                (view.parent as? ViewGroup)?.removeView(view)
                container.addView(
                    view,
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                )
                hideSystemBars(true)
            }

            override fun onHideCustomView() {
                val view = customView ?: return
                webView.visibility = View.VISIBLE
                container.removeView(view)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                hideSystemBars(false)
            }

            override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                val msg = message ?: return true
                if (msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.w(TAG, "WebView console: ${msg.message()} @${msg.lineNumber()}")
                }
                return true
            }
        }

        webView.webChromeClient = chromeClient
        appChromeClient = chromeClient
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val requestUri = request?.url ?: return null
                val host = requestUri.host?.lowercase() ?: ""
                val path = requestUri.path ?: ""
                val isLocalApp = host == "appassets.androidplatform.net" ||
                    host == "localhost" ||
                    host == "127.0.0.1"

                if (isLocalApp && path == "/assets/public/wasm/otium_ui_bg.wasm") {
                    return WebResourceResponse("application/wasm", null, assets.open("public/wasm/otium_ui_bg.wasm"))
                }

                if (isLocalApp && path == "/api/cinemana/subtitle") {
                    return RustApi.response(requestUri.toString())
                }
                if (isLocalApp && path == "/api/media") {
                    return RustApi.response(requestUri.toString(), request.requestHeaders["Range"] ?: request.requestHeaders["range"] ?: "")
                }

                if (isLocalApp && path.startsWith("/api/")) {
                    if (request.method.equals("OPTIONS", ignoreCase = true)) {
                        return corsResponse(204, "No Content", "")
                    }
                    return try {
                        val json = RustApi.request(requestUri.toString())
                        WebResourceResponse(
                            "application/json",
                            "UTF-8",
                            200,
                            "OK",
                            corsHeaders(),
                            json.byteInputStream(Charsets.UTF_8)
                        )
                    } catch (e: Exception) {
                        Log.e(TAG, "Scraper interception error: ${e.message}", e)
                        val body = JSONObject()
                            .put("error", e.message ?: "Internal error")
                            .toString()
                        WebResourceResponse(
                            "application/json",
                            "UTF-8",
                            500,
                            "Internal Error",
                            corsHeaders(),
                            body.byteInputStream(Charsets.UTF_8)
                        )
                    }
                }

                val assetResponse = assetLoader.shouldInterceptRequest(requestUri)
                if (assetResponse != null) return assetResponse

                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString()?.lowercase() ?: return true

                if (url.startsWith("https://appassets.androidplatform.net") ||
                    url.startsWith("file://") ||
                    url.startsWith("about:blank")
                ) {
                    return false
                }

                // Video players and CDNs live in subframes; never block those.
                if (request?.isForMainFrame == false) return false

                Log.d(TAG, "Prevented external navigation on main frame: $url")
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                view?.evaluateJavascript(
                    "document.documentElement.classList.add('krmzi-native');",
                    null
                )
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Log.w(TAG, "Main frame error: ${error?.description}")
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?
            ) {
                super.onReceivedHttpError(view, request, errorResponse)
                if (request?.isForMainFrame == true) {
                    Log.w(TAG, "Main frame HTTP ${errorResponse?.statusCode} for ${request.url}")
                }
            }

            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?
            ): Boolean {
                val crashed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) detail?.didCrash() else null
                Log.e(TAG, "WebView renderer gone (crashed=$crashed)")
                if (!isDestroyed) recreateWebView()
                return true
            }
        }
    }

    private fun corsHeaders(): MutableMap<String, String> = mutableMapOf(
        "Access-Control-Allow-Origin" to "*",
        "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers" to "*",
        "Cache-Control" to "no-store",
        "X-Krmzi-Native" to "1"
    )

    private fun corsResponse(status: Int, reason: String, body: String): WebResourceResponse =
        WebResourceResponse(
            "application/json",
            "UTF-8",
            status,
            reason,
            corsHeaders(),
            ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
        )

    private fun recreateWebView() {
        try {
            container.removeView(webView)
            webView.stopLoading()
            webView.removeJavascriptInterface("KrmziBridge")
            webView.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to destroy crashed WebView: ${e.message}")
        }

        customView = null
        customViewCallback = null
        isVideoPlaying = false

        createWebView()
        container.addView(webView)
        configureWebView()
        webView.loadUrl(APP_URL)
    }

    /* ------------------------------------------------------------------ */
    /*  Navigation                                                         */
    /* ------------------------------------------------------------------ */

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) {
                    appChromeClient?.onHideCustomView()
                    return
                }
                if (!::webView.isInitialized || isDestroyed) {
                    finish()
                    return
                }

                webView.evaluateJavascript(
                    """
                    (function() {
                        if (window.krmziIsSheetOpen && window.krmziIsSheetOpen()) {
                            window.krmziCloseSheet();
                            return true;
                        }
                        if (window.krmziIsPlayerOpen && window.krmziIsPlayerOpen()) {
                            window.krmziClosePlayer();
                            return true;
                        }
                        if (window.krmziIsSearchOpen && window.krmziIsSearchOpen()) {
                            window.krmziCloseSearch();
                            return true;
                        }
                        return false;
                    })()
                    """.trimIndent()
                ) { result ->
                    if (result != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    /* ------------------------------------------------------------------ */
    /*  Picture-in-picture, insets and memory                              */
    /* ------------------------------------------------------------------ */

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (isVideoPlaying && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                if (!isInPictureInPictureMode) {
                    enterPictureInPictureMode(
                        PictureInPictureParams.Builder()
                            .setAspectRatio(Rational(16, 9))
                            .build()
                    )
                }
            } catch (e: Exception) {
                Log.w(TAG, "PiP error: ${e.message}")
            }
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        if (!::webView.isInitialized || isDestroyed) return
        val script = if (isInPictureInPictureMode) {
            "document.getElementById('playerHudTop')?.classList.add('hud-hidden');" +
                "document.getElementById('playerHudBottom')?.classList.add('hud-hidden');"
        } else {
            "document.getElementById('playerHudTop')?.classList.remove('hud-hidden');" +
                "document.getElementById('playerHudBottom')?.classList.remove('hud-hidden');"
        }
        webView.evaluateJavascript(script, null)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars(isVideoPlaying || customView != null)
    }

    private fun hideSystemBars(fullscreen: Boolean) {
        try {
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (fullscreen) {
                controller.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                controller.hide(WindowInsetsCompat.Type.statusBars())
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unable to update system bars: ${e.message}")
        }
    }

    override fun onPause() {
        val inPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isInPictureInPictureMode
        if (::webView.isInitialized && !inPip) {
            webView.onPause()
            webView.pauseTimers()
        }
        try {
            CookieManager.getInstance().flush()
        } catch (_: Exception) {
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.resumeTimers()
        }
    }

    override fun onLowMemory() {
        super.onLowMemory()
        if (::webView.isInitialized) webView.clearCache(false)
        RustApi.trimMemory()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            if (::webView.isInitialized) webView.clearCache(false)
            RustApi.trimMemory()
        }
    }

    override fun onDestroy() {
        isDestroyed = true
        try {
            if (::webView.isInitialized) {
                webView.stopLoading()
                webView.removeJavascriptInterface("KrmziBridge")
                webView.loadUrl("about:blank")
                webView.clearHistory()
                webView.removeAllViews()
                webView.destroy()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WebView cleanup failed: ${e.message}")
        }
        RustApi.clearMemoryCache()
        super.onDestroy()
    }
}
