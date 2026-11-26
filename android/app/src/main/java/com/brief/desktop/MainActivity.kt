package com.brief.desktop

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts the full Brief v2.0.1 HTML/CSS/JS UI via AndroidX `WebViewAssetLoader`
 * (`https://appassets.androidplatform.net/assets/app.html`) — Google's official
 * secure origin standard (`allowFileAccess = false`, zero file-URL flags, zero
 * Play Protect / Samsung McAfee WebView false positives) with Samsung Algorithmic
 * Darkening disabled (zero muddy gray wash!) and hardware-accelerated 60-120fps animations.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var vault: ApiKeyVault
    private val aiClient = BriefAiClient()
    private lateinit var agent: PhoneAgentRunner
    private lateinit var webView: WebView
    private lateinit var uiPrefs: android.content.SharedPreferences
    private var setupDialog: AlertDialog? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#090A0D")
        window.navigationBarColor = Color.parseColor("#090A0D")

        vault = ApiKeyVault(this)
        uiPrefs = getSharedPreferences("brief_ui_state_v201", Context.MODE_PRIVATE)
        agent = PhoneAgentRunner(this, aiClient, vault)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#090A0D"))
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            isVerticalScrollBarEnabled = true
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                textZoom = 86
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_NO_CACHE
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    @Suppress("DEPRECATION")
                    isForceDarkAllowed = false
                }
                if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                    WebSettingsCompat.setAlgorithmicDarkeningAllowed(this, false)
                }
            }
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    val resp = assetLoader.shouldInterceptRequest(request.url) ?: return null
                    val headers = HashMap<String, String>(resp.responseHeaders ?: emptyMap())
                    headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
                    headers["Pragma"] = "no-cache"
                    headers["Expires"] = "0"
                    resp.responseHeaders = headers
                    return resp
                }
            }
            addJavascriptInterface(BriefJsBridge(), "BriefAndroidBridge")
        }
        setContentView(webView)
        webView.clearCache(true)
        webView.loadUrl("https://appassets.androidplatform.net/assets/app.html?v=210")

        // Automatically request official Android runtime Notifications permission on launch so Permissions is never empty!
        if (Build.VERSION.SDK_INT >= 33 && !OemCompatibilityHelper.hasNotificationPermission(this)) {
            androidx.core.app.ActivityCompat.requestPermissions(
                this,
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                1001
            )
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshSetupDialogUi()
        emitJsEvent("models:updated", buildBundleObject())
    }

    override fun onResume() {
        super.onResume()
        refreshSetupDialogUi()
        emitJsEvent("models:updated", buildBundleObject())
    }

    private fun emitJsEvent(channel: String, payload: JSONObject) {
        runOnUiThread {
            val script = "window.__briefAndroidEvent && window.__briefAndroidEvent(${JSONObject.quote(channel)}, $payload);"
            webView.evaluateJavascript(script, null)
        }
    }

    private fun resolveJsCall(callId: String, result: JSONObject?, error: String? = null) {
        runOnUiThread {
            val resPart = result?.toString() ?: "null"
            val errPart = if (error != null) JSONObject.quote(error) else "null"
            val script = "window.__briefAndroidResolve && window.__briefAndroidResolve(${JSONObject.quote(callId)}, $resPart, $errPart);"
            webView.evaluateJavascript(script, null)
        }
    }

    private fun maskKey(k: String?): String {
        val s = k?.trim().orEmpty()
        if (s.isEmpty()) return ""
        if (s.length <= 10) return "••••"
        return s.take(5) + "••••••••" + s.takeLast(4)
    }

    private fun buildSlotsJson(): JSONObject {
        val slots = JSONObject()
        for (p in ProviderId.entries) {
            val raw = vault.getKey(p)
            slots.put(
                p.wireId,
                JSONObject().apply {
                    put("has", !raw.isNullOrBlank())
                    put("masked", maskKey(raw))
                }
            )
        }
        return slots
    }

    private fun buildModelsForProvider(p: ProviderId): JSONArray {
        val arr = JSONArray()
        for (m in ProviderModels.presetsFor(p)) {
            arr.put(
                JSONObject().apply {
                    put("id", m.id)
                    put("name", "models/${m.id}")
                    put("displayName", m.label)
                    put("description", m.hint)
                    put("thinking", m.supportsThinking)
                    put("methods", JSONArray().put("generateContent"))
                }
            )
        }
        return arr
    }

    private fun buildPresetsForProvider(p: ProviderId): JSONArray {
        val arr = JSONArray()
        for (m in ProviderModels.presetsFor(p)) {
            arr.put(
                JSONObject().apply {
                    put("key", m.id)
                    put("id", m.id)
                    put("label", m.label)
                    put("hint", m.hint)
                }
            )
        }
        return arr
    }

    private fun buildSettingsObject(): JSONObject {
        val raw = uiPrefs.getString("settings_json", null)
        val obj = runCatching { if (raw != null) JSONObject(raw) else JSONObject() }.getOrElse { JSONObject() }
        val activeProv = vault.getActiveProvider()
        obj.put("provider", activeProv.wireId)
        obj.put("activeModel", vault.getActiveModel(activeProv))
        obj.put("thinkingLevel", vault.getThinkingLevel().wire)
        val isLargeTablet = OemCompatibilityHelper.isTablet(this) && resources.configuration.smallestScreenWidthDp >= 720
        if (!obj.has("permissionMode")) obj.put("permissionMode", "full")
        if (!obj.has("touchTypingMode")) obj.put("touchTypingMode", "touch")
        if (!obj.has("sidebarCollapsed")) obj.put("sidebarCollapsed", !isLargeTablet)
        return obj
    }

    private fun buildDiagnosticsObject(): JSONObject {
        val accOk = BriefAccessibilityService.isEnabled(this)
        val permsOk = OemCompatibilityHelper.hasCoreAppPermissions(this)
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val checks = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("id", "android-app-permissions")
                    put("name", "1. App & Background Permissions (Notifications + Keep-Alive)")
                    put("status", if (permsOk) "granted" else "required")
                    put("ok", permsOk)
                    put("detail", if (permsOk) "Granted ✓ App & background execution permissions active." else "Tap 'Grant Permissions' to allow Notifications & Always-Run-In-Background.")
                }
            )
            put(
                JSONObject().apply {
                    put("id", "android-accessibility")
                    put("name", "2. Brief Assistant Screen Control (Un-Gray + Touch + Cursors)")
                    put("status", if (accOk) "granted" else "required")
                    put("ok", accOk)
                    put("detail", if (accOk) "Enabled (${w}x${h}) — Floating provider cursors, touch & vision ready with zero root." else "Tap the green 'Enable Android Control Permissions' button to un-gray and activate Brief Assistant.")
                }
            )
        }
        val guides = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("title", OemCompatibilityHelper.detectedBrandLabel(this@MainActivity))
                    put("steps", JSONArray().put(OemCompatibilityHelper.getZeroRootSetupGuide(this@MainActivity)))
                }
            )
        }
        return JSONObject().apply {
            put("platform", "android")
            put("accessibilityEnabled", accOk)
            put("permissionsGranted", permsOk)
            put("osLabel", OemCompatibilityHelper.detectedBrandLabel(this@MainActivity))
            put("backendName", "Android Safe Mode · Trusted Accessibility Overlay")
            put("dpiMode", "${w}x${h}")
            put("checks", checks)
            put("limitations", JSONArray().put("Zero root & zero background recording permissions. Banking/DRM screens with FLAG_SECURE are protected by Android OS."))
            put("guides", guides)
        }
    }

    private fun buildBundleObject(validationObj: JSONObject? = null): JSONObject {
        val prov = vault.getActiveProvider()
        val rawKey = vault.getKey(prov)
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val settingsObj = buildSettingsObject()
        if (validationObj != null) {
            settingsObj.put("lastValidation", validationObj)
        }
        val chatsRaw = uiPrefs.getString("chats_json", null)
        val chatsObj = runCatching {
            if (chatsRaw != null) JSONObject(chatsRaw) else JSONObject().put("chats", JSONArray()).put("projects", JSONArray())
        }.getOrElse { JSONObject().put("chats", JSONArray()).put("projects", JSONArray()) }

        val isTablet = OemCompatibilityHelper.isTablet(this)
        return JSONObject().apply {
            put("version", "2.1.0-beta")
            put("firstRunRequested", false)
            put(
                "os",
                JSONObject().apply {
                    put("platform", "android")
                    put("release", Build.VERSION.RELEASE ?: "15")
                    put("type", OemCompatibilityHelper.detectedBrandLabel(this@MainActivity))
                    put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64")
                    put("backendName", if (isTablet) "Android Tablet · Safe Accessibility Overlay" else "Android Phone · Safe Accessibility Overlay")
                }
            )
            put(
                "displays",
                JSONArray().put(
                    JSONObject().apply {
                        put("index", 0)
                        put("id", 0)
                        put("label", if (isTablet) "Tablet Screen (${w}x${h})" else "Phone Screen (${w}x${h})")
                        put("primary", true)
                        put("scaleFactor", resources.displayMetrics.density.toDouble())
                    }
                )
            )
            put("diagnostics", buildDiagnosticsObject())
            val slots = buildSlotsJson()
            put(
                "key",
                JSONObject().apply {
                    put("has", !rawKey.isNullOrBlank())
                    put("masked", maskKey(rawKey))
                    put("backend", "Android Hardware Keystore (AES-256-GCM)")
                    put("available", true)
                    put("slots", slots)
                }
            )
            put("slots", slots)
            put("provider", prov.wireId)
            put("settings", settingsObj)
            put("chatsData", chatsObj)
            put("models", buildModelsForProvider(prov))
            put("presets", buildPresetsForProvider(prov))
            if (validationObj != null) put("validation", validationObj)
        }
    }

    inner class BriefJsBridge {
        @JavascriptInterface
        fun getBootstrapJson(): String = buildBundleObject().toString()

        @JavascriptInterface
        fun getKeyStatusJson(): String = buildBundleObject().optJSONObject("key")?.toString() ?: "{}"

        @JavascriptInterface
        fun getKeySlotsJson(): String = buildSlotsJson().toString()

        @JavascriptInterface
        fun getDiagnosticsJson(): String = buildDiagnosticsObject().toString()

        @JavascriptInterface
        fun switchKeySlotJson(providerWire: String): String {
            val p = ProviderId.fromWire(providerWire)
            vault.setActiveProvider(p)
            return buildBundleObject().toString()
        }

        @JavascriptInterface
        fun removeKeyJson(providerWire: String): String {
            val p = if (providerWire.isNotBlank()) ProviderId.fromWire(providerWire) else vault.getActiveProvider()
            vault.clearKey(p)
            return buildBundleObject().toString()
        }

        @JavascriptInterface
        fun updateSettingsJson(patchJson: String): String {
            val current = buildSettingsObject()
            val patch = runCatching { JSONObject(patchJson) }.getOrElse { JSONObject() }
            val keys = patch.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                current.put(k, patch.get(k))
            }
            if (patch.has("provider")) {
                vault.setActiveProvider(ProviderId.fromWire(patch.optString("provider")))
            }
            if (patch.has("activeModel")) {
                val m = patch.optString("activeModel")
                if (m.isNotBlank()) vault.setActiveModel(vault.getActiveProvider(), m)
            }
            if (patch.has("thinkingLevel")) {
                val tl = ThinkingLevel.entries.firstOrNull { it.wire == patch.optString("thinkingLevel") }
                if (tl != null) vault.setThinkingLevel(tl)
            }
            uiPrefs.edit().putString("settings_json", current.toString()).apply()
            return current.toString()
        }

        @JavascriptInterface
        fun saveChatsJson(chatsJson: String) {
            uiPrefs.edit().putString("chats_json", chatsJson).apply()
        }

        @JavascriptInterface
        fun openExternalUrl(url: String) {
            runOnUiThread {
                try {
                    val clean = if (url.startsWith("http://") || url.startsWith("https://")) url else "https://$url"
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(clean)))
                } catch (_: Exception) {}
            }
        }

        @JavascriptInterface
        fun openPhoneSetupDialog() {
            runOnUiThread { showNativePhoneSetupDialog() }
        }

        @JavascriptInterface
        fun startAndroidApkUpdateJson(apkUrl: String, versionTag: String): String {
            val cleanUrl = apkUrl.trim().ifEmpty {
                "https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/Brief-Android.apk"
            }
            val safeVer = versionTag.replace(Regex("[^a-zA-Z0-9._-]"), "").ifEmpty { "latest" }
            return try {
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
                val req = android.app.DownloadManager.Request(Uri.parse(cleanUrl)).apply {
                    setTitle("Brief Update v$safeVer")
                    setDescription("Downloading Brief v$safeVer for Android — tap when complete to install update.")
                    setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setMimeType("application/vnd.android.package-archive")
                    setAllowedOverMetered(true)
                    setAllowedOverRoaming(true)
                    setDestinationInExternalPublicDir(
                        android.os.Environment.DIRECTORY_DOWNLOADS,
                        "Brief-Android-$safeVer.apk"
                    )
                }
                val downloadId = dm.enqueue(req)
                // Also open the direct APK URL in browser so Samsung/Honor browsers offer immediate 1-tap Update!
                runOnUiThread {
                    android.widget.Toast.makeText(
                        this@MainActivity,
                        "Downloading Brief v$safeVer update… Tap 'Update' when prompted!",
                        android.widget.Toast.LENGTH_LONG
                    ).show()
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(cleanUrl)))
                    } catch (_: Exception) {}
                }
                JSONObject().put("ok", true).put("downloadId", downloadId).put("url", cleanUrl).toString()
            } catch (e: Exception) {
                runOnUiThread {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(cleanUrl)))
                    } catch (_: Exception) {}
                }
                JSONObject().put("ok", true).put("fallbackBrowser", true).put("url", cleanUrl).toString()
            }
        }

        @JavascriptInterface
        fun captureScreenAttachmentJson(): String {
            return JSONObject().put("canceled", true).toString()
        }

        @JavascriptInterface
        fun stopAgent() {
            agent.stop()
            emitJsEvent("agent:status", JSONObject().put("running", false).put("state", "idle").put("stepText", "Stopped"))
        }

        @JavascriptInterface
        fun validateKeyAsync(callId: String, argJson: String) {
            val args = runCatching { JSONObject(argJson) }.getOrElse { JSONObject() }
            val rawInputKey = args.optString("key").trim()
            val shouldSave = args.optBoolean("save", true)
            val detected = if (rawInputKey.isNotEmpty()) ProviderId.detectFromKey(rawInputKey) else vault.getActiveProvider()
            val keyToTest = if (rawInputKey.isNotEmpty()) rawInputKey else vault.getKey(detected).orEmpty()

            lifecycleScope.launch {
                if (keyToTest.isEmpty()) {
                    val v = JSONObject().apply {
                        put("status", "nokey")
                        put("icon", "❌")
                        put("title", "No API Key")
                        put("message", "Paste your API key first.")
                        put("steps", JSONArray())
                    }
                    resolveJsCall(callId, buildBundleObject(v))
                    return@launch
                }
                val (ok, msg) = withContext(Dispatchers.IO) { aiClient.validateAndSetup(detected, keyToTest) }
                if (ok && shouldSave) {
                    vault.saveKey(detected, keyToTest)
                }
                val v = JSONObject().apply {
                    put("status", if (ok) "valid" else "invalid")
                    put("icon", if (ok) "✅" else "❌")
                    put("title", if (ok) "${detected.displayName} Key Verified · Real & Ready" else "${detected.displayName} Key Rejected")
                    put("message", msg)
                    put(
                        "steps",
                        JSONArray().put(
                            JSONObject().put("step", "verify-${detected.wireId}").put("ok", ok).put("detail", msg)
                        )
                    )
                }
                resolveJsCall(callId, buildBundleObject(v))
            }
        }

        @JavascriptInterface
        fun runChatAsync(callId: String, payloadJson: String) {
            val payload = runCatching { JSONObject(payloadJson) }.getOrElse { JSONObject() }
            val msgs = payload.optJSONArray("messages") ?: JSONArray()
            val lastPrompt = if (msgs.length() > 0) msgs.optJSONObject(msgs.length() - 1)?.optString("text").orEmpty() else ""
            val prov = vault.getActiveProvider()
            val model = vault.getActiveModel(prov)

            emitJsEvent("agent:status", JSONObject().put("running", true).put("mode", "chat").put("stepText", "Thinking…"))
            lifecycleScope.launch {
                val reply = withContext(Dispatchers.IO) {
                    agent.runUserMessage(lastPrompt, workMode = false, onStep = { stepTxt ->
                        emitJsEvent("agent:status", JSONObject().put("running", true).put("mode", "chat").put("stepText", stepTxt))
                    })
                }
                emitJsEvent("agent:status", JSONObject().put("running", false).put("mode", "chat").put("stepText", "Ready"))
                resolveJsCall(
                    callId,
                    JSONObject().apply {
                        put("text", reply)
                        put("model", model)
                    }
                )
            }
        }

        @JavascriptInterface
        fun runWorkAsync(callId: String, payloadJson: String) {
            val payload = runCatching { JSONObject(payloadJson) }.getOrElse { JSONObject() }
            val chatId = payload.optString("chatId")
            val workVisualMode = payload.optString("workVisualMode", "photos")
            val task = payload.optString("task").ifEmpty {
                val msgs = payload.optJSONArray("messages") ?: JSONArray()
                if (msgs.length() > 0) msgs.optJSONObject(msgs.length() - 1)?.optString("text").orEmpty() else ""
            }
            val prov = vault.getActiveProvider()
            val model = vault.getActiveModel(prov)

            if (!BriefAccessibilityService.isEnabled(this@MainActivity)) {
                runOnUiThread { showNativePhoneSetupDialog() }
            }

            val settingsNow = buildSettingsObject()
            val touchTypingMode = payload.optString(
                "touchTypingMode",
                settingsNow.optString("touchTypingMode", "touch")
            )
            val rawSpeed = settingsNow.optLong("cursorSpeedMs", 580L)
            val profile = settingsNow.optString("cursorSpeedProfile", "balanced").lowercase()
            val effectiveSpeedMs = when {
                rawSpeed in 180L..1500L && rawSpeed != 220L -> rawSpeed
                profile == "slow" || profile == "deliberate" -> 820L
                profile == "fast" -> 340L
                else -> 580L
            }

            val collectedSteps = JSONArray()
            emitJsEvent("agent:status", JSONObject().put("running", true).put("mode", "work").put("stepText", "150f Live Vision — Starting…"))
            lifecycleScope.launch {
                val reply = withContext(Dispatchers.IO) {
                    agent.runUserMessage(
                        prompt = task,
                        workMode = true,
                        workVisualMode = workVisualMode,
                        cursorSpeedMs = effectiveSpeedMs,
                        touchTypingMode = touchTypingMode,
                        onStep = { stepTxt ->
                            emitJsEvent("agent:status", JSONObject().put("running", true).put("mode", "work").put("stepText", stepTxt))
                        },
                        onStepItem = { item ->
                            collectedSteps.put(item)
                            emitJsEvent(
                                "agent:work-step",
                                JSONObject().put("chatId", chatId).put("item", item)
                            )
                        },
                        onPlan = { planObj ->
                            emitJsEvent(
                                "agent:work-plan",
                                JSONObject()
                                    .put("chatId", chatId)
                                    .put("plan", planObj.optString("plan"))
                                    .put("planSteps", planObj.optJSONArray("planSteps"))
                            )
                        }
                    )
                }
                emitJsEvent("agent:status", JSONObject().put("running", false).put("mode", "work").put("stepText", "Ready"))
                resolveJsCall(
                    callId,
                    JSONObject().apply {
                        put("text", reply)
                        put("model", model)
                        put("steps", collectedSteps)
                    }
                )
            }
        }
    }

    private fun refreshSetupDialogUi() {
        val accOk = BriefAccessibilityService.isEnabled(this)
        val permsOk = OemCompatibilityHelper.hasCoreAppPermissions(this)
        val isAr = OemCompatibilityHelper.isArabicLocale()
        val needsUnGray = OemCompatibilityHelper.needsAndroid13RestrictedUnlock()
        setupDialog?.let { dlg ->
            dlg.findViewById<View>(R.id.rowSamsungAutoBlocker)?.visibility =
                if (OemCompatibilityHelper.isSamsung() && !accOk) View.VISIBLE else View.GONE
            dlg.findViewById<View>(R.id.rowStep2TriggerGray)?.visibility =
                if (needsUnGray) View.VISIBLE else View.GONE
            dlg.findViewById<View>(R.id.rowStep3UnlockDots)?.visibility =
                if (needsUnGray) View.VISIBLE else View.GONE

            if (isAr) {
                dlg.findViewById<TextView>(R.id.txtSetupHeaderTitle)?.text = "إعداد أذونات وتحكم Brief لأجهزة أندرويد"
                dlg.findViewById<TextView>(R.id.txtSetupHeaderSub)?.text = "يعمل على أجهزة Honor MagicOS وسامسونج وجميع هواتف وأجهزة أندرويد اللوحية."
                dlg.findViewById<TextView>(R.id.titleSamsungAutoBlocker)?.text = "خطوة سامسونج: إيقاف الحظر التلقائي (Auto Blocker)"
                dlg.findViewById<TextView>(R.id.titleStep1Perms)?.text = "١. منح أذونات التطبيق والعمل بالخلفية"
                dlg.findViewById<TextView>(R.id.titleStep2Trigger)?.text = "٢. اضغط الزر الرمادي مرة واحدة أولاً!"
                dlg.findViewById<TextView>(R.id.titleStep3Unlock)?.text = "٣. فك القفل من قائمة التطبيقات (⋮ أعلى اليسار)"
                dlg.findViewById<TextView>(R.id.titleStep4Enable)?.text = "٤. تفعيل تحكم Brief Assistant"
            }

            dlg.findViewById<TextView>(R.id.txtOverlayStatus)?.text = when {
                permsOk -> if (isAr) "تم منح الأذونات ✓ الإشعارات والعمل بالخلفية مفعّلة" else "Granted ✓ Notifications & Always-Run-In-Background active"
                isAr -> "يفتح نافذة أندرويد الرسمية للسماح بالإشعارات والعمل في الخلفية"
                else -> "Pops up official Android Notifications & Always-Run-In-Background permissions"
            }
            dlg.findViewById<TextView>(R.id.btnGrantOverlay)?.text = when {
                permsOk -> if (isAr) "تم ✓" else "Granted ✓"
                isAr -> "سماح"
                else -> "Allow"
            }

            dlg.findViewById<TextView>(R.id.txtTriggerGrayStatus)?.text = when {
                accOk -> if (isAr) "تم التجاوز ✓" else "Done ✓"
                isAr -> "افتح Brief Assistant ← اضغط الزر الرمادي مرة واحدة حتى تظهر (تم منع التطبيق من الوصول) ثم اضغط (إغلاق) وارجع هنا!"
                else -> "Tap Brief Assistant → tap the gray switch ONCE until 'App was denied access' pops up → tap Close & come back!"
            }
            dlg.findViewById<TextView>(R.id.btnTriggerGraySwitch)?.text = when {
                accOk -> "✓"
                isAr -> "اضغط ١×"
                else -> "Tap 1x"
            }

            dlg.findViewById<TextView>(R.id.txtScreenCapStatus)?.text = when {
                accOk -> if (isAr) "تم فك القفل الرمادي ✓" else "Unlocked ✓ Gray switch restriction cleared"
                isAr -> "اختر Brief من قائمة التطبيقات ← اضغط النقاط الثلاث (⋮) أعلى اليسار ← (السماح بالإعدادات المقيدة)!"
                else -> "Tap 'Brief' in Apps list → tap top corner ⋮ (or bottom on Xiaomi) → 'Allow restricted settings'!"
            }
            dlg.findViewById<TextView>(R.id.btnGrantScreenCap)?.text = when {
                accOk -> "✓"
                isAr -> "فك القفل ⋮"
                else -> "Unlock ⋮"
            }

            dlg.findViewById<TextView>(R.id.txtAccessibilityStatus)?.text = when {
                accOk -> if (isAr) "مفعّل ✓ المؤشرات واللمس والتحكم الكامل جاهز!" else "Active ✓ Floating cursors, touch & screen control enabled!"
                isAr -> "الآن الزر لم يعد رمادياً! افتح وفعّل Brief Assistant (ON)"
                else -> "Switch is now UN-GRAYED! Tap here & toggle Brief Assistant ON"
            }
            dlg.findViewById<TextView>(R.id.btnGrantAccessibility)?.text = when {
                accOk -> if (isAr) "مفعّل ✓" else "Active ✓"
                isAr -> "تفعيل"
                else -> "Turn ON"
            }
        }
    }

    private fun showNativePhoneSetupDialog() {
        if (setupDialog?.isShowing == true) return
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_setup, null)
        val dlg = AlertDialog.Builder(this)
            .setView(view)
            .create()
        setupDialog = dlg

        var selectedProv = vault.getActiveProvider()
        val tabs = mapOf(
            ProviderId.GEMINI to view.findViewById<TextView>(R.id.tabProvGemini),
            ProviderId.OPENAI to view.findViewById<TextView>(R.id.tabProvOpenAi),
            ProviderId.ANTHROPIC to view.findViewById<TextView>(R.id.tabProvClaude),
            ProviderId.OPENROUTER to view.findViewById<TextView>(R.id.tabProvOpenRouter)
        )
        val txtKeyStatus = view.findViewById<TextView>(R.id.txtKeyStatus)
        val inputApiKey = view.findViewById<EditText>(R.id.inputApiKey)

        fun paintTabs() {
            for ((p, tv) in tabs) {
                val active = (p == selectedProv)
                tv.background = GradientDrawable().apply {
                    setColor(if (active) p.accentColorHex.toInt() else 0xFF191F30.toInt())
                    cornerRadius = 999f
                }
                val savedMark = if (vault.hasKey(p)) " ✓" else ""
                tv.text = p.displayName + savedMark
                tv.setTextColor(if (active) 0xFFFFFFFF.toInt() else 0xFF94A3B8.toInt())
            }
            txtKeyStatus.text = if (vault.hasKey(selectedProv)) {
                "Encrypted key saved for ${selectedProv.displayName}."
            } else {
                "Paste your ${selectedProv.displayName} API key above."
            }
        }
        paintTabs()

        for ((p, tv) in tabs) {
            tv.setOnClickListener {
                selectedProv = p
                if (vault.hasKey(p)) {
                    vault.setActiveProvider(p)
                }
                paintTabs()
            }
        }

        view.findViewById<TextView>(R.id.btnVerifySaveKey).setOnClickListener {
            val rawKey = inputApiKey.text.toString().trim()
            if (rawKey.isEmpty()) {
                txtKeyStatus.text = "Please paste an API key first."
                return@setOnClickListener
            }
            val detected = ProviderId.detectFromKey(rawKey)
            selectedProv = detected
            paintTabs()
            txtKeyStatus.text = "Verifying ${detected.displayName} key…"
            lifecycleScope.launch {
                val (ok, msg) = withContext(Dispatchers.IO) { aiClient.validateAndSetup(detected, rawKey) }
                if (ok) {
                    vault.saveKey(detected, rawKey)
                    inputApiKey.setText("")
                    paintTabs()
                    txtKeyStatus.text = msg
                    emitJsEvent("models:updated", buildBundleObject())
                } else {
                    txtKeyStatus.text = msg
                }
            }
        }

        view.findViewById<TextView>(R.id.btnSaveNameOnly).setOnClickListener {
            vault.clearKey(selectedProv)
            paintTabs()
            txtKeyStatus.text = "Cleared ${selectedProv.displayName} key."
        }

        view.findViewById<TextView>(R.id.btnSamsungAutoBlocker)?.setOnClickListener {
            OemCompatibilityHelper.openOemStep1SettingsSafe(this)
        }

        view.findViewById<TextView>(R.id.btnGrantOverlay).setOnClickListener {
            OemCompatibilityHelper.requestNativeControlPermissions(this)
        }

        view.findViewById<TextView>(R.id.btnTriggerGraySwitch)?.setOnClickListener {
            OemCompatibilityHelper.openAccessibilityTriggerStep(this)
        }

        view.findViewById<TextView>(R.id.btnGrantScreenCap).setOnClickListener {
            OemCompatibilityHelper.openAppsListForRestrictedUnlock(this)
        }

        view.findViewById<TextView>(R.id.btnGrantAccessibility).setOnClickListener {
            OemCompatibilityHelper.openAccessibilitySettingsSafe(this)
        }

        view.findViewById<TextView>(R.id.txtSamsungHelp).apply {
            text = OemCompatibilityHelper.getZeroRootSetupGuide(this@MainActivity)
            setOnClickListener {
                OemCompatibilityHelper.openAppsListForRestrictedUnlock(this@MainActivity)
            }
        }

        view.findViewById<TextView>(R.id.btnCloseSetup).setOnClickListener {
            dlg.dismiss()
        }

        dlg.setOnDismissListener {
            if (setupDialog === dlg) setupDialog = null
        }
        dlg.show()
        refreshSetupDialogUi()
    }
}
