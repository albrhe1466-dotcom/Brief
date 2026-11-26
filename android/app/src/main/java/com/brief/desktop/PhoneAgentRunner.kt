package com.brief.desktop

import android.content.Context
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

    private fun formatUiSnapshotForAi(uiObj: JSONObject?): String {
        if (uiObj == null) return ""
        val pkg = uiObj.optString("packageName", "unknown")
        val arr = uiObj.optJSONArray("elements") ?: return ""
        if (arr.length() == 0) return "\n[Active App: $pkg | UI Elements: loading or canvas-only — rely on the calibrated 0..1000 screenshot grid]"
        val sb = StringBuilder("\n[Active App: $pkg | Live 150-Node Interactive UI Map (0..1000 coords)]:\n")
        val limit = arr.length().coerceAtMost(90)
        for (i in 0 until limit) {
            val el = arr.optJSONObject(i) ?: continue
            val lbl = el.optString("label")
            val x = el.optInt("x")
            val y = el.optInt("y")
            val flags = buildList {
                if (el.optBoolean("editable")) add("INPUT")
                if (el.optBoolean("focused")) add("FOCUSED")
                if (el.optBoolean("clickable")) add("TAP")
            }.joinToString(",")
            sb.append("- ($x, $y) [$flags] \"$lbl\"\n")
        }
        return sb.toString()
    }

    suspend fun runUserMessage(
        prompt: String,
        workMode: Boolean,
        workVisualMode: String = "photos",
        cursorSpeedMs: Long = 560L,
        onStep: (String) -> Unit,
        onStepItem: ((JSONObject) -> Unit)? = null
    ): String {
        stopped = false
        BriefAccessibilityService.configuredCursorSpeedMs = cursorSpeedMs.coerceIn(220L, 1400L)

        val isBgVisual = workVisualMode.equals("background", ignoreCase = true)
        val provider = vault.getActiveProvider()
        val apiKey = vault.getKey(provider)
            ?: return "Please open Setup and verify your ${provider.displayName} API key first."
        val rawModel = vault.getActiveModel(provider)
        val isComplexPrompt = workMode || prompt.length > 160 ||
            Regex("\\b(code|debug|fix|implement|build|refactor|analyze|compare|prove|calculate|step[- ]by[- ]step|plan|youtube|search|channel|video|short)\\b|```", RegexOption.IGNORE_CASE).containsMatchIn(prompt)
        val model = if (provider == ProviderId.OPENAI && (rawModel.equals("auto", true) || rawModel.equals("openai_auto", true))) {
            if (isComplexPrompt) "gpt-6.1-terra" else "gpt-6-luna"
        } else rawModel
        val thinking = vault.getThinkingLevel()

        val accInit = BriefAccessibilityService.instance
        if (workMode && !isBgVisual) {
            startOverlayIfAllowed(provider, "Observing (150f)…")
        }

        val initialFrame = if (workMode && accInit != null) {
            onStep("150f Live Vision — Observing screen…")
            accInit.captureLiveVisionFrame(settleMaxMs = 450L)
        } else null
        val initialUi = if (workMode && accInit != null) accInit.readScreenElements(150) else null

        if (workMode && !isBgVisual && initialFrame != null) {
            onStepItem?.invoke(
                JSONObject().apply {
                    put("step", 0)
                    put("toolCallId", "observe-init")
                    put("tool", "live_vision_150f")
                    put("description", "Live 150f Eyes (${initialFrame.sampledFrames}f settled)")
                    put("running", false)
                    put("ok", true)
                    put("screenshot", "data:image/jpeg;base64,${initialFrame.cleanUserBase64}")
                    put("forcePhoto", true)
                }
            )
        }

        val enrichedPrompt = if (workMode) {
            prompt + formatUiSnapshotForAi(initialUi) +
                "\n[Calibrated 0..1000 HD screenshot attached. Execute the user's FULL multi-step goal step-by-step until completely finished on screen!]"
        } else {
            prompt
        }

        history.add(
            ConversationTurn(
                role = "user",
                text = enrichedPrompt,
                imageBase64 = initialFrame?.calibratedAiBase64
            )
        )

        val sysPrompt = buildSystemPrompt(workMode, thinking)
        val toolDefs = buildToolsJson(workMode)
        val maxSteps = if (workMode) 40 else if (thinking == ThinkingLevel.EXTRA) 6 else 4
        val requiresMultiStepCompletion = workMode &&
            Regex("\\b(search|find|click|tap|channel|latest|video|short|shorts|watch|play|send|message|type)\\b", RegexOption.IGNORE_CASE).containsMatchIn(prompt)

        var executedActionCount = 0
        var prematureFinishNudges = 0
        var lastRepeatedSig = ""
        var sameSigStreak = 0

        try {
            for (step in 1..maxSteps) {
                if (stopped) return "Stopped by user."
                onStep(if (workMode) "Step $step — Thinking & checking…" else "Thinking…")
                if (workMode && !isBgVisual) {
                    BriefAccessibilityService.instance?.updateOverlayState(provider, "Step $step · Thinking…")
                }

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
                    // Anti-premature-exit gate: never let the AI stop right after just opening an app when the user asked to search/click/watch!
                    if (requiresMultiStepCompletion && executedActionCount < 3 && prematureFinishNudges < 3 && BriefAccessibilityService.instance != null) {
                        prematureFinishNudges++
                        val accNow = BriefAccessibilityService.instance!!
                        if (!isBgVisual) accNow.updateOverlayState(provider, "Continuing task…")
                        val checkFrame = accNow.captureLiveVisionFrame(settleMaxMs = 800L, expectAwayFromBrief = true)
                        val checkUi = accNow.readScreenElements(150)
                        history.add(
                            ConversationTurn(
                                role = "user",
                                text = "[GOAL AUDIT — DO NOT STOP EARLY]: You have only executed $executedActionCount action(s) so far, which is NOT enough to complete the user's full request: \"$prompt\". " +
                                    "Look closely at the live 150f screenshot and UI map below, and call the next tool NOW (e.g. tap Search, type_text with submit=true, tap the channel avatar/row, tap Videos or Shorts, and open the latest post)!" +
                                    formatUiSnapshotForAi(checkUi),
                                imageBase64 = checkFrame?.calibratedAiBase64
                            )
                        )
                        continue
                    }
                    return res.text.ifEmpty { "Done." }
                }

                val results = mutableListOf<Pair<ToolCallSpec, String>>()
                var openedExternalAppThisTurn = false
                var lastStepFrame: VisionFrame? = null

                for (tc in res.toolCalls) {
                    if (stopped) return "Stopped by user."
                    val sig = "${tc.name}:${tc.args}"
                    if (sig == lastRepeatedSig) sameSigStreak++ else {
                        lastRepeatedSig = sig
                        sameSigStreak = 1
                    }

                    val humanDesc = describeToolCall(tc)
                    onStep("Step $step — $humanDesc")
                    val callId = tc.id.ifEmpty { "step_${step}_${tc.name}" }
                    onStepItem?.invoke(
                        JSONObject().apply {
                            put("step", step)
                            put("toolCallId", callId)
                            put("tool", tc.name)
                            put("description", humanDesc)
                            put("label", humanDesc)
                            put("running", true)
                        }
                    )
                    if (workMode && !isBgVisual) {
                        BriefAccessibilityService.instance?.updateOverlayState(provider, humanDesc)
                    }

                    val out = if (sameSigStreak >= 4) {
                        JSONObject().put("error", "Repeated identical action 4 times; try a different coordinate, tap_element, or swipe to scroll.").toString()
                    } else {
                        executeTool(tc, provider)
                    }

                    if (tc.name in setOf("open_app", "open_url", "tap", "tap_element", "double_tap", "type_text", "swipe")) {
                        executedActionCount++
                    }
                    if (tc.name == "open_app" || tc.name == "open_url") {
                        openedExternalAppThisTurn = true
                    }

                    // Capture a fresh live 150f settled frame right after the action so both the user & AI see live progress!
                    val accAfter = BriefAccessibilityService.instance
                    val stepFrame = if (workMode && accAfter != null) {
                        accAfter.captureLiveVisionFrame(
                            settleMaxMs = if (openedExternalAppThisTurn) 1400L else 700L,
                            expectAwayFromBrief = openedExternalAppThisTurn
                        )
                    } else null
                    if (stepFrame != null) lastStepFrame = stepFrame

                    onStepItem?.invoke(
                        JSONObject().apply {
                            put("step", step)
                            put("toolCallId", callId)
                            put("tool", tc.name)
                            put("description", "$humanDesc → ${summarizeResult(out)}")
                            put("label", "$humanDesc → ${summarizeResult(out)}")
                            put("running", false)
                            put("ok", !out.contains("\"error\""))
                            if (!isBgVisual && stepFrame != null) {
                                put("screenshot", "data:image/jpeg;base64,${stepFrame.cleanUserBase64}")
                                put("forcePhoto", true)
                            }
                        }
                    )
                    results.add(tc to out)
                }

                val accEnd = BriefAccessibilityService.instance
                val latestFrame = if (workMode && accEnd != null) {
                    lastStepFrame ?: accEnd.captureLiveVisionFrame(
                        settleMaxMs = if (openedExternalAppThisTurn) 900L else 420L,
                        expectAwayFromBrief = openedExternalAppThisTurn
                    )
                } else null
                val latestUi = if (workMode && accEnd != null) accEnd.readScreenElements(150) else null

                history.add(ConversationTurn(role = "tool_results", toolResults = results))
                if (latestFrame != null || latestUi != null) {
                    history.add(
                        ConversationTurn(
                            role = "user",
                            text = "[Live 150f Screen Updated After Step $step — verify visually whether the full goal (\"$prompt\") is 100% done; if more steps remain, execute the next action immediately!]" +
                                formatUiSnapshotForAi(latestUi),
                            imageBase64 = latestFrame?.calibratedAiBase64
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

    private fun describeToolCall(tc: ToolCallSpec): String {
        val a = tc.args
        return when (tc.name) {
            "open_app" -> "Opening ${a.optString("name")}"
            "tap_element" -> "Checking & tapping \"${a.optString("label")}\""
            "tap" -> "Moving cursor & tapping (${a.optInt("x")}, ${a.optInt("y")})"
            "type_text" -> "Typing \"${a.optString("text").take(28)}\""
            "swipe" -> "Scrolling screen (${a.optInt("y1")} → ${a.optInt("y2")})"
            "press_back" -> "Pressing Back"
            "press_home" -> "Going Home"
            "web_search" -> "Searching web: ${a.optString("query").take(28)}"
            else -> tc.name
        }
    }

    private fun summarizeResult(raw: String): String {
        val obj = runCatching { JSONObject(raw) }.getOrNull() ?: return raw.take(64)
        if (obj.has("error")) return "Error: ${obj.optString("error").take(60)}"
        if (obj.has("detail")) return obj.optString("detail").take(72)
        return if (obj.optBoolean("ok", true)) "OK" else "Retry needed"
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
                delay(a.optLong("ms", 900L).coerceIn(150L, 4500L))
                JSONObject().put("ok", true).toString()
            }
            "read_screen_ui" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Enable Brief Accessibility Service in Setup first.").toString()
                acc.readScreenElements(150).toString()
            }
            "tap_element" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val (ok, msg) = acc.tapElementByLabel(a.optString("label"))
                delay(280L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            "tap" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val ok = acc.tapNormalized(a.optDouble("x", 500.0), a.optDouble("y", 500.0), a.optBoolean("longPress", false))
                delay(280L)
                JSONObject().put("ok", ok).toString()
            }
            "double_tap" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val ok = acc.doubleTapNormalized(a.optDouble("x", 500.0), a.optDouble("y", 500.0))
                delay(260L)
                JSONObject().put("ok", ok).toString()
            }
            "swipe" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val ok = acc.swipeNormalized(
                    a.optDouble("x1", 500.0),
                    a.optDouble("y1", 720.0),
                    a.optDouble("x2", 500.0),
                    a.optDouble("y2", 260.0),
                    a.optLong("ms", 420L)
                )
                delay(320L)
                JSONObject().put("ok", ok).toString()
            }
            "type_text" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val (ok, msg) = acc.typeTextIntoFocused(a.optString("text"), a.optBoolean("submit", true))
                delay(320L)
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
                delay(850L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            "open_url" -> {
                val acc = BriefAccessibilityService.instance
                val (ok, msg) = if (acc != null) acc.openWebUrl(a.optString("url")) else (false to "Accessibility off.")
                delay(750L)
                JSONObject().put("ok", ok).put("detail", msg).toString()
            }
            else -> JSONObject().put("error", "Unknown tool ${tc.name}").toString()
        }
    }

    private fun buildSystemPrompt(workMode: Boolean, thinking: ThinkingLevel): String {
        val extraHint = if (thinking == ThinkingLevel.EXTRA) {
            "\nThinking Level is EXTRA: double-check every visual detail, verify timestamps/labels on screen, and deliver a thorough result."
        } else ""
        return if (!workMode) {
            "You are Brief on Android (Chat Mode). Answer clearly, quickly, and accurately. Use web_search and fetch_url whenever current or live web research helps.$extraHint"
        } else {
            """You are Brief on Android (Work Mode — Smart 150-Frame Vision Phone & Tablet Agent).
You have LIVE calibrated HD screenshots (0..1000 x 0..1000 coordinate ruler on top/left edges, where 0,0 is top-left and 1000,1000 is bottom-right) PLUS a 150-node interactive UI element map on EVERY step.

CRITICAL EXECUTION RULES (BE SMART, THOROUGH & NEVER QUIT EARLY):
1. COMPLETE EVERY STEP OF THE USER'S GOAL: Never stop right after opening an app! If the user says "open YouTube, search MrBeast, click the Beast channel icon, and open/give his latest Short or latest video":
   - Step A: Call `open_app({"name": "YouTube"})`.
   - Step B: Tap the Search icon (`tap_element({"label": "Search"})` or `tap` on the magnifying glass in the top bar).
   - Step C: Call `type_text({"text": "MrBeast", "submit": true})` so the search actually executes!
   - Step D: Inspect the search results carefully! Look for the official channel row / circular Beast avatar icon (e.g. `@MrBeast` / channel header, NOT an ad or random clip) and tap it to open the channel page.
   - Step E: On the channel page, tap the `Videos` or `Shorts` tab chip, inspect the newest upload (check relative timestamps like "hours ago" / "days ago" and skip older pinned items if needed), and tap it so it plays on screen (or report its exact title & details as asked).
2. PREFER PRECISION: Use the `[Live 150-Node Interactive UI Map]` coordinates or `tap_element` whenever a button/tab/channel has a clear label, and use the calibrated `0..1000` screenshot grid for visual icons/thumbnails/avatars.
3. IF SOMETHING IS OFF-SCREEN: Use `swipe` (`x1=500, y1=760, x2=500, y2=260`) to scroll down smoothly and inspect new items.
4. SAFETY: Pause and ask the user only before irreversible payments, password entry, or permanent deletion.$extraHint"""
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
            addTool("read_screen_ui", "Read up to 150 clickable/editable UI labels and 0..1000 center coordinates on screen.", JSONObject())
            addTool(
                "tap_element",
                "Move cursor, check, and tap a visible button, icon, tab, channel, or input box by its text, contentDescription, or resource id.",
                JSONObject().put("label", JSONObject().put("type", "string").put("description", "Visible text, contentDescription, or icon id (e.g. 'Search', 'Shorts', 'Videos', 'MrBeast')")),
                listOf("label")
            )
            addTool(
                "tap",
                "Glide Brief's cursor, check target, and tap (or long-press) at normalized 0..1000 screen coordinates.",
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
                "Swipe/scroll smoothly between normalized 0..1000 coordinates (e.g. x1=500, y1=760, x2=500, y2=260 scrolls down).",
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
                "Type text into the focused/visible input or search bar. Set submit=true (default) to press Search/Enter automatically!",
                JSONObject()
                    .put("text", JSONObject().put("type", "string"))
                    .put("submit", JSONObject().put("type", "boolean").put("description", "True to press Search/Enter after typing")),
                listOf("text")
            )
            addTool("press_back", "Press the Android system Back button.", JSONObject())
            addTool("press_home", "Press the Android system Home button.", JSONObject())
            addTool(
                "open_app",
                "Launch any installed Android app directly by name (e.g. 'YouTube', 'Chrome', 'Settings').",
                JSONObject().put("name", JSONObject().put("type", "string")),
                listOf("name")
            )
            addTool(
                "open_url",
                "Open a URL directly on the device.",
                JSONObject().put("url", JSONObject().put("type", "string")),
                listOf("url")
            )
            addTool(
                "wait_ms",
                "Wait briefly (150..4500 ms) for video/page loading.",
                JSONObject().put("ms", JSONObject().put("type", "integer")),
                listOf("ms")
            )
        }
        return arr
    }
}
