package com.brief.desktop

import android.content.Context
import android.content.Intent
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

class PhoneAgentRunner(
    private val context: Context,
    private val aiClient: BriefAiClient,
    private val vault: ApiKeyVault
) {
    private val history = mutableListOf<ConversationTurn>()

    @Volatile
    var stopped: Boolean = false

    fun reset() {
        history.clear()
        stopped = false
    }

    fun stop() {
        stopped = true
        BriefAccessibilityService.instance?.hideOverlay()
    }

    suspend fun runUserMessage(
        prompt: String,
        workMode: Boolean,
        onStep: (String) -> Unit,
        onStepItem: ((JSONObject) -> Unit)? = null
    ): String {
        stopped = false
        val provider = vault.getActiveProvider()
        val apiKey = vault.getKey(provider)
            ?: return "Please open Setup and verify your ${provider.displayName} API key first."
        val model = vault.getActiveModel(provider)
        val thinking = vault.getThinkingLevel()

        val initialShot = if (workMode && BriefAccessibilityService.instance != null) {
            onStep("Looking at your phone screen…")
            BriefAccessibilityService.instance?.captureScreenshotJpegBase64()
        } else null

        if (workMode) {
            startOverlayIfAllowed(provider, "Starting…")
        }

        val userTurn = ConversationTurn(
            role = "user",
            text = prompt,
            imageBase64 = initialShot
        )
        history.add(userTurn)

        val sysPrompt = buildSystemPrompt(workMode, thinking)
        val toolDefs = buildToolsJson(workMode)
        val maxSteps = if (workMode) 16 else if (thinking == ThinkingLevel.EXTRA) 6 else 4

        try {
            for (step in 1..maxSteps) {
                if (stopped) return "Stopped by user."
                onStep(if (workMode) "Step $step — Thinking…" else "Thinking…")
                if (workMode) BriefAccessibilityService.instance?.updateOverlayState(provider, "Step $step…")

                val res = aiClient.generate(
                    provider = provider,
                    apiKey = apiKey,
                    modelId = model,
                    thinking = thinking,
                    systemPrompt = sysPrompt,
                    history = history,
                    toolDefs = toolDefs
                )

                history.add(
                    ConversationTurn(
                        role = "model",
                        text = res.text,
                        modelPartsJson = res.rawPartsJson,
                        toolCalls = res.toolCalls
                    )
                )

                if (res.toolCalls.isEmpty()) {
                    return res.text.ifEmpty { "Done." }
                }

                val results = mutableListOf<Pair<ToolCallSpec, String>>()
                for (tc in res.toolCalls) {
                    if (stopped) return "Stopped by user."
                    onStep("Running ${tc.name}…")
                    val callId = tc.id.ifEmpty { "step_${step}_${tc.name}" }
                    onStepItem?.invoke(
                        JSONObject().apply {
                            put("step", step)
                            put("toolCallId", callId)
                            put("tool", tc.name)
                            put("label", "${tc.name}(${tc.args.toString().take(60)})")
                            put("running", true)
                        }
                    )
                    if (workMode) BriefAccessibilityService.instance?.updateOverlayState(provider, tc.name)
                    val out = executeTool(tc, provider)
                    onStepItem?.invoke(
                        JSONObject().apply {
                            put("step", step)
                            put("toolCallId", callId)
                            put("tool", tc.name)
                            put("label", "${tc.name} → ${out.take(80)}")
                            put("running", false)
                            put("ok", !out.contains("\"error\""))
                        }
                    )
                    results.add(tc to out)
                }

                val nextShot = if (workMode && BriefAccessibilityService.instance != null) {
                    BriefAccessibilityService.instance?.captureScreenshotJpegBase64()
                } else null

                history.add(ConversationTurn(role = "tool_results", toolResults = results))
                if (nextShot != null) {
                    history.add(
                        ConversationTurn(
                            role = "user",
                            text = "[Updated phone screen after actions]",
                            imageBase64 = nextShot
                        )
                    )
                }
            }
            return "Finished maximum steps cleanly. Ask me to continue if you want another step."
        } catch (e: Exception) {
            return "Error: ${e.message ?: "Request failed"}"
        } finally {
            if (workMode) {
                BriefAccessibilityService.instance?.hideOverlay()
            }
        }
    }

    private fun startOverlayIfAllowed(provider: ProviderId, status: String) {
        BriefAccessibilityService.onUserStopRequested = { stop() }
        BriefAccessibilityService.instance?.showOverlay(provider, status)
    }

    private suspend fun executeTool(tc: ToolCallSpec, provider: ProviderId): String {
        val a = tc.args
        return when (tc.name) {
            "web_search" -> aiClient.webSearch(a.optString("query"))
            "fetch_url" -> aiClient.fetchUrlText(a.optString("url"))
            "wait_ms" -> {
                delay(a.optLong("ms", 800L).coerceIn(100L, 4000L))
                JSONObject().put("ok", true).toString()
            }
            "read_screen_ui" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Enable Brief Accessibility Service in Setup first.").toString()
                acc.readScreenElements().toString()
            }
            "tap_element" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val (ok, msg) = acc.tapElementByLabel(a.optString("label"))
                delay(320L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            "tap" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val ok = acc.tapNormalized(a.optDouble("x", 500.0), a.optDouble("y", 500.0), a.optBoolean("longPress", false))
                delay(320L)
                JSONObject().put("ok", ok).toString()
            }
            "double_tap" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val ok = acc.doubleTapNormalized(a.optDouble("x", 500.0), a.optDouble("y", 500.0))
                delay(280L)
                JSONObject().put("ok", ok).toString()
            }
            "swipe" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val ok = acc.swipeNormalized(
                    a.optDouble("x1", 500.0),
                    a.optDouble("y1", 700.0),
                    a.optDouble("x2", 500.0),
                    a.optDouble("y2", 300.0),
                    a.optLong("ms", 340L)
                )
                delay(350L)
                JSONObject().put("ok", ok).toString()
            }
            "type_text" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val (ok, msg) = acc.typeTextIntoFocused(a.optString("text"), a.optBoolean("submit", false))
                delay(250L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            "press_back" -> {
                val ok = BriefAccessibilityService.instance?.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK) == true
                delay(300L)
                JSONObject().put("ok", ok).toString()
            }
            "press_home" -> {
                val ok = BriefAccessibilityService.instance?.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME) == true
                delay(350L)
                JSONObject().put("ok", ok).toString()
            }
            "open_app" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val (ok, msg) = acc.launchAppByName(a.optString("name"))
                delay(700L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            "open_url" -> {
                val acc = BriefAccessibilityService.instance
                val (ok, msg) = if (acc != null) acc.openWebUrl(a.optString("url")) else (false to "Accessibility off.")
                delay(650L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            else -> JSONObject().put("error", "Unknown tool ${tc.name}").toString()
        }
    }

    private fun buildSystemPrompt(workMode: Boolean, thinking: ThinkingLevel): String {
        val extraHint = if (thinking == ThinkingLevel.EXTRA) {
            "\nThinking Level is EXTRA: run deeper live web_search / fetch_url research and include extra clear verification and helpful finishing details."
        } else ""
        return if (!workMode) {
            "You are Brief on Android (Chat Mode). Answer clearly, quickly, and accurately. Use web_search and fetch_url whenever current or live web research helps.$extraHint"
        } else {
            """You are Brief on Android (Work Mode — Zero-Root Phone Assistant).
You control the phone cleanly with normalized coordinates (0..1000 x 0..1000 where 0,0 is top-left and 1000,1000 is bottom-right) and research tools.
Always inspect screen elements via read_screen_ui before tapping if no screenshot was attached, or use exact visual coordinates from the attached screenshot.
Use tap, swipe, type_text, open_app, open_url, press_back, press_home, web_search, and fetch_url.
Stop politely and ask the user if you reach a banking login, password, payment, or delete confirmation.$extraHint"""
        }
    }

    private fun buildToolsJson(workMode: Boolean): JSONArray {
        val arr = JSONArray()
        fun addTool(name: String, desc: String, props: JSONObject, required: List<String> = emptyList()) {
            val params = JSONObject().put("type", "object").put("properties", props)
            if (required.isNotEmpty()) params.put("required", JSONArray(required))
            arr.put(JSONObject().put("name", name).put("description", desc).put("parameters", params))
        }

        addTool(
            "web_search",
            "Search the live internet for facts, news, documentation, or guides.",
            JSONObject().put("query", JSONObject().put("type", "string").put("description", "Search query")),
            listOf("query")
        )
        addTool(
            "fetch_url",
            "Fetch and read clean readable text from a webpage URL.",
            JSONObject().put("url", JSONObject().put("type", "string")),
            listOf("url")
        )

        if (workMode) {
            addTool("read_screen_ui", "Read clickable/editable UI labels and 0..1000 center coordinates on the phone or tablet screen.", JSONObject())
            addTool(
                "tap_element",
                "Tap a visible button, tab, link, or input box by its text or label (most accurate on both Android phones and tablets).",
                JSONObject().put("label", JSONObject().put("type", "string").put("description", "Visible text or icon label to tap")),
                listOf("label")
            )
            addTool(
                "tap",
                "Tap (or long-press) on the phone screen at normalized 0..1000 coordinates while moving the Brief cursor.",
                JSONObject()
                    .put("x", JSONObject().put("type", "number"))
                    .put("y", JSONObject().put("type", "number"))
                    .put("longPress", JSONObject().put("type", "boolean")),
                listOf("x", "y")
            )
            addTool(
                "double_tap",
                "Double-tap at normalized 0..1000 coordinates.",
                JSONObject().put("x", JSONObject().put("type", "number")).put("y", JSONObject().put("type", "number")),
                listOf("x", "y")
            )
            addTool(
                "swipe",
                "Swipe/scroll between normalized 0..1000 coordinates (e.g. y1=780 to y2=260 scrolls down).",
                JSONObject()
                    .put("x1", JSONObject().put("type", "number"))
                    .put("y1", JSONObject().put("type", "number"))
                    .put("x2", JSONObject().put("type", "number"))
                    .put("y2", JSONObject().put("type", "number"))
                    .put("ms", JSONObject().put("type", "integer")),
                listOf("x1", "y1", "x2", "y2")
            )
            addTool(
                "type_text",
                "Type text into the focused phone input field.",
                JSONObject()
                    .put("text", JSONObject().put("type", "string"))
                    .put("submit", JSONObject().put("type", "boolean")),
                listOf("text")
            )
            addTool("open_app", "Launch an installed Android app by name (e.g. Chrome, Settings, Notes, YouTube).", JSONObject().put("name", JSONObject().put("type", "string")), listOf("name"))
            addTool("open_url", "Open a URL directly in the phone browser.", JSONObject().put("url", JSONObject().put("type", "string")), listOf("url"))
            addTool("press_back", "Press Android system Back.", JSONObject())
            addTool("press_home", "Return to Phone Home Screen.", JSONObject())
            addTool("wait_ms", "Wait briefly for an app or page to finish loading.", JSONObject().put("ms", JSONObject().put("type", "integer")))
        }
        return arr
    }
}
