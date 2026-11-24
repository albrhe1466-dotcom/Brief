package com.brief.desktop

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts the full Brief v2.0.1 HTML/CSS/JS UI (`file:///android_asset/app.html`)
 * inside a hardware-accelerated edge-to-edge WebView so Android phones have the
 * EXACT same animated 3-slide onboarding, forced provider fonts (Google Sans,
 * OpenAI Sans, Claude Sans / Newsreader, Plus Jakarta Sans), Usage Ring,
 * What's New modal, and themes as Windows & Linux, wired directly to Android's
 * zero-root Floating Cursor Overlay, AccessibilityService, and MediaProjection.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var vault: ApiKeyVault
    private val aiClient = BriefAiClient()
    private lateinit var agent: PhoneAgentRunner
    private lateinit var webView: WebView
    private lateinit var uiPrefs: android.content.SharedPreferences
    private var setupDialog: AlertDialog? = null

    private val screenCapLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val svc = Intent(this, ScreenCaptureService::class.java).apply {
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svc)
            } else {
                startService(svc)
            }
            Toast.makeText(this, "Live screen vision enabled!", Toast.LENGTH_SHORT).show()
        }
        refreshSetupDialogUi()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#0B0D14")
        window.navigationBarColor = Color.parseColor("#0B0D14")

        vault = ApiKeyVault(this)
        uiPrefs = getSharedPreferences("brief_ui_state_v201", Context.MODE_PRIVATE)
        agent = PhoneAgentRunner(this, aiClient, vault)

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0D14"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = true
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = true
                textZoom = 100
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            }
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
            addJavascriptInterface(BriefJsBridge(), "BriefAndroidBridge")
        }
        setContentView(webView)
        webView.loadUrl("file:///android_asset/app.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        refreshSetupDialogUi()
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
        if (!obj.has("permissionMode")) obj.put("permissionMode", "full")
        if (!obj.has("sidebarCollapsed")) obj.put("sidebarCollapsed", true)
        return obj
    }

    private fun buildDiagnosticsObject(): JSONObject {
        val overlayOk = CursorOverlayService.canDrawOverlays(this)
        val accOk = BriefAccessibilityService.isEnabled(this)
        val screenOk = ScreenCaptureService.isReady()
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val checks = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("id", "android-overlay")
                    put("name", "1. Floating Provider Cursor Overlay (Appear on Top)")
                    put("status", if (overlayOk) "granted" else "required")
                    put("detail", if (overlayOk) "Granted — Gemini, Claude, OpenAI & OpenRouter cursors active." else "Tap 'Test Overlay' below to allow floating cursor over apps.")
                }
            )
            put(
                JSONObject().apply {
                    put("id", "android-accessibility")
                    put("name", "2. Zero-Root Phone Control (Accessibility Service)")
                    put("status", if (accOk) "granted" else "required")
                    put("detail", if (accOk) "Enabled — Taps, swipes, app launching & typing ready." else "Tap 'Test Input' below to enable Brief in Accessibility.")
                }
            )
            put(
                JSONObject().apply {
                    put("id", "android-vision")
                    put("name", "3. Live Screen Vision (MediaProjection)")
                    put("status", if (screenOk) "granted" else "optional")
                    put("detail", if (screenOk) "Active (${w}x${h})" else "Optional — tap 'Test Overlay' to share screen vision alongside UI labels.")
                }
            )
        }
        val guides = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("title", OemCompatibilityHelper.detectedBrandLabel())
                    put("steps", JSONArray().put(OemCompatibilityHelper.getZeroRootSetupGuide()))
                }
            )
        }
        return JSONObject().apply {
            put("platform", "android")
            put("osLabel", OemCompatibilityHelper.detectedBrandLabel())
            put("backendName", "Android Zero-Root · Floating Cursor + Accessibility")
            put("dpiMode", "${w}x${h}")
            put("checks", checks)
            put("limitations", JSONArray().put("Zero root required. Banking/DRM screens with FLAG_SECURE are protected by Android OS."))
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

        return JSONObject().apply {
            put("version", "2.0.1")
            put("firstRunRequested", false)
            put(
                "os",
                JSONObject().apply {
                    put("platform", "android")
                    put("release", Build.VERSION.RELEASE ?: "14")
                    put("type", OemCompatibilityHelper.detectedBrandLabel())
                    put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64")
                    put("backendName", "Android Zero-Root · Cursor + Accessibility")
                }
            )
            put(
                "displays",
                JSONArray().put(
                    JSONObject().apply {
                        put("index", 0)
                        put("id", 0)
                        put("label", "Phone Screen (${w}x${h})")
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
            val task = payload.optString("task").ifEmpty {
                val msgs = payload.optJSONArray("messages") ?: JSONArray()
                if (msgs.length() > 0) msgs.optJSONObject(msgs.length() - 1)?.optString("text").orEmpty() else ""
            }
            val prov = vault.getActiveProvider()
            val model = vault.getActiveModel(prov)

            if (!CursorOverlayService.canDrawOverlays(this@MainActivity) || !BriefAccessibilityService.isEnabled(this@MainActivity)) {
                runOnUiThread { showNativePhoneSetupDialog() }
            }

            val collectedSteps = JSONArray()
            emitJsEvent("agent:status", JSONObject().put("running", true).put("mode", "work").put("stepText", "Starting phone work…"))
            lifecycleScope.launch {
                val reply = withContext(Dispatchers.IO) {
                    agent.runUserMessage(
                        prompt = task,
                        workMode = true,
                        onStep = { stepTxt ->
                            emitJsEvent("agent:status", JSONObject().put("running", true).put("mode", "work").put("stepText", stepTxt))
                        },
                        onStepItem = { item ->
                            collectedSteps.put(item)
                            emitJsEvent(
                                "agent:work-step",
                                JSONObject().put("chatId", chatId).put("item", item)
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
        val overlayOk = CursorOverlayService.canDrawOverlays(this)
        val accOk = BriefAccessibilityService.isEnabled(this)
        val screenOk = ScreenCaptureService.isReady()
        setupDialog?.let { dlg ->
            dlg.findViewById<TextView>(R.id.txtOverlayStatus)?.text =
                if (overlayOk) "Granted ✓ Floating provider cursor enabled" else "Needed so you can see Brief's cursor over every app"
            dlg.findViewById<TextView>(R.id.btnGrantOverlay)?.text = if (overlayOk) "Granted ✓" else "Allow"

            dlg.findViewById<TextView>(R.id.txtAccessibilityStatus)?.text =
                if (accOk) "Granted ✓ Zero-root taps & typing enabled" else "Needed so Brief can tap, swipe & open apps without root"
            dlg.findViewById<TextView>(R.id.btnGrantAccessibility)?.text = if (accOk) "Enabled ✓" else "Enable"

            dlg.findViewById<TextView>(R.id.txtScreenCapStatus)?.text =
                if (screenOk) "Active ✓ Screen vision streaming cleanly" else "Optional: lets Brief see screenshots alongside UI tree"
            dlg.findViewById<TextView>(R.id.btnGrantScreenCap)?.text = if (screenOk) "Active ✓" else "Share"
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

        view.findViewById<TextView>(R.id.btnGrantOverlay).setOnClickListener {
            OemCompatibilityHelper.openOverlaySettingsSafe(this)
        }

        view.findViewById<TextView>(R.id.btnGrantAccessibility).setOnClickListener {
            OemCompatibilityHelper.openAccessibilitySettingsSafe(this)
        }

        view.findViewById<TextView>(R.id.btnGrantScreenCap).setOnClickListener {
            try {
                val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                screenCapLauncher.launch(mgr.createScreenCaptureIntent())
            } catch (e: Exception) {
                Toast.makeText(this, "Screen capture unavailable: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }

        view.findViewById<TextView>(R.id.txtSamsungHelp).apply {
            text = OemCompatibilityHelper.getZeroRootSetupGuide()
            setOnClickListener {
                OemCompatibilityHelper.openAppDetailsSafe(this@MainActivity)
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
