package com.brief.desktop

import android.content.Context
import android.os.PowerManager
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

class PhoneAgentRunner(
    private val context: Context,
    private val aiClient: BriefAiClient,
    private val vault: ApiKeyVault
) {
    private val history = mutableListOf<ConversationTurn>()

    companion object {
        // Strictly wholesome watching + snack emojis (zero inappropriate emojis)
        private val WATCH_SNACK_EMOJIS = listOf(
            "👀🍿", "👀🍕", "👀☕", "👀🍪", "👀🍩",
            "👀🍔", "👀🍟", "👀🧃", "👀🥨", "👀🍵"
        )
        private val WATCH_LOADING_WORD_RE = Regex(
            "\\b(loading(?:\\.\\.\\.|\\s+\\d|\\s+[a-z]+)|is\\s+reading|reading\\.\\.\\.|is\\s+thinking|thinking\\.\\.\\.|thought\\s+for|is\\s+analyzing|analyzing\\.\\.\\.|searching\\s+the\\s+web|searching\\.\\.\\.|flashing|validating|verifying\\.\\.\\.|generating(?:\\s+video|\\.\\.\\.)|rendering|downloading|uploading|installing|uninstalling|extracting|decompressing|compiling|building\\.\\.\\.|writing\\s+image|formatting|copying\\s+(?:iso|files)|transferring|syncing\\.\\.\\.|initializing|processing\\.\\.\\.|please\\s+wait|in\\s+progress|\\d+\\s*(?:sec|min|hr|m|s)\\s+remaining|eta\\b|queued|preparing\\.\\.\\.|stop\\s+generating|running\\s+command|working\\.\\.\\.)\\b",
            RegexOption.IGNORE_CASE
        )
        private val EXTERNAL_AI_GUARD_RULES = listOf(
            Triple("Claude", Regex("\\bclaude(?:\\.ai|\\s*code|\\s*desktop)?\\b|anthropic\\.com/claude", RegexOption.IGNORE_CASE), Regex("\\bclaude\\b", RegexOption.IGNORE_CASE)),
            Triple("ChatGPT", Regex("\\bchatgpt\\b|chat\\.openai\\.com", RegexOption.IGNORE_CASE), Regex("\\b(?:chatgpt|openai\\s+chat)\\b", RegexOption.IGNORE_CASE)),
            Triple("Gemini", Regex("gemini\\.google\\.com", RegexOption.IGNORE_CASE), Regex("gemini\\.google\\.com|\\bopen\\s+gemini\\b", RegexOption.IGNORE_CASE)),
            Triple("Perplexity", Regex("\\bperplexity(?:\\.ai)?\\b", RegexOption.IGNORE_CASE), Regex("\\bperplexity\\b", RegexOption.IGNORE_CASE)),
            Triple("Copilot", Regex("copilot\\.microsoft\\.com|\\bcopilot\\b", RegexOption.IGNORE_CASE), Regex("\\bcopilot\\b", RegexOption.IGNORE_CASE)),
            Triple("DeepSeek", Regex("\\bdeepseek(?:\\.com)?\\b", RegexOption.IGNORE_CASE), Regex("\\bdeepseek\\b", RegexOption.IGNORE_CASE)),
            Triple("Grok", Regex("\\bgrok\\.com\\b", RegexOption.IGNORE_CASE), Regex("\\bgrok\\b", RegexOption.IGNORE_CASE)),
            Triple("Poe", Regex("\\bpoe\\.com\\b", RegexOption.IGNORE_CASE), Regex("\\bpoe\\.com|\\bopen\\s+poe\\b", RegexOption.IGNORE_CASE))
        )
        private val WATCH_PERMISSION_RE = Regex(
            "\\b(allow\\s+once|allow\\s+always|allow\\s+this|accept\\s+all|approve|permission\\s+required|wants?\\s+to\\s+(?:access|run|open|edit|read|write|execute|use)|do\\s+you\\s+want\\s+to\\s+allow|grant\\s+(?:access|permission)|yes,\\s*proceed|run\\s+command\\?|open\\s+folder\\?|trust\\s+(?:this|the)\\s+folder|allow\\s+access|while\\s+using\\s+the\\s+app|only\\s+this\\s+time)\\b",
            RegexOption.IGNORE_CASE
        )
        private val WATCH_ERROR_RE = Regex(
            "\\b(error:|failed|failure|denied|access\\s+denied|permission\\s+denied|rejected|unable\\s+to|could\\s+not|cannot|exception|crashed|fatal|abort(?:ed)?|validation\\s+failed|something\\s+went\\s+wrong|corrupt(?:ed)?|not\\s+enough\\s+space|try\\s+again|retry)\\b",
            RegexOption.IGNORE_CASE
        )
        private val WATCH_DONE_RE = Regex(
            "\\b(flash\\s+complete|completed?\\s+successfully|finished\\s+successfully|all\\s+done|100%\\s*(?:complete|done|finished)|successfully\\s+(?:installed|flashed|generated|rendered|built|downloaded|completed|created|verified)|ready\\s+to\\s+download|video\\s+ready|export\\s+complete|done!)\\b",
            RegexOption.IGNORE_CASE
        )
        private val WATCH_PCT_RE = Regex("\\b(\\d{1,3})(?:\\.\\d+)?\\s*%")
        private val IMPATIENT_WAIT_TEXT_RE = Regex(
            "\\b(i['’]?m\\s+still\\s+waiting|still\\s+waiting|currently\\s+(?:loading|running|flashing|validating|generating|reading|thinking|working)|in\\s+progress|let\\s+me\\s+know\\s+when\\s+(?:it|this)\\s+finish|waiting\\s+for\\s+(?:it|the|claude|chatgpt|ai|terminal|etcher|rufus))\\b",
            RegexOption.IGNORE_CASE
        )
        private const val MAX_EXTERNAL_PERMISSION_GRANTS = 16
    }

    private fun pickWatchEmoji(tick: Int): String =
        WATCH_SNACK_EMOJIS[(tick and 0x7FFFFFFF) % WATCH_SNACK_EMOJIS.size]

    private fun formatWatchElapsed(ms: Long): String {
        val totalSec = (ms / 1000L).coerceAtLeast(0L)
        val hrs = totalSec / 3600L
        val mins = (totalSec % 3600L) / 60L
        val secs = totalSec % 60L
        return when {
            hrs > 0L -> "${hrs}h ${mins.toString().padStart(2, '0')}m"
            mins > 0L -> "${mins}m ${secs.toString().padStart(2, '0')}s"
            else -> "${secs}s"
        }
    }

    private fun extractUiTextForWatch(uiObj: JSONObject?): String {
        if (uiObj == null) return ""
        val sb = StringBuilder()
        val pkg = uiObj.optString("packageName")
        if (pkg.isNotEmpty()) sb.append("APP:").append(pkg).append(" | ")
        val arr = uiObj.optJSONArray("elements") ?: return sb.toString()
        for (i in 0 until arr.length().coerceAtMost(130)) {
            val lbl = arr.optJSONObject(i)?.optString("label").orEmpty().trim()
            if (lbl.length >= 2) sb.append(lbl).append(" | ")
        }
        return sb.toString().take(8000)
    }

    private data class WatchSignal(
        val isLoading: Boolean,
        val loadingHit: String,
        val hasPermissionPrompt: Boolean,
        val permissionHit: String,
        val hasError: Boolean,
        val errorHit: String,
        val isDone: Boolean,
        val doneHit: String
    )

    private fun analyzeWatchText(raw: String, doneKws: List<String> = emptyList(), errorKws: List<String> = emptyList()): WatchSignal {
        val txt = raw.replace(Regex("\\s+"), " ").trim()
        val low = txt.lowercase()
        val permHit = WATCH_PERMISSION_RE.find(txt)?.value.orEmpty()
        val customErr = errorKws.firstOrNull { it.isNotBlank() && low.contains(it.lowercase()) }.orEmpty()
        val errHit = customErr.ifEmpty { WATCH_ERROR_RE.find(txt)?.value.orEmpty() }
        val customDone = doneKws.firstOrNull { it.isNotBlank() && low.contains(it.lowercase()) }.orEmpty()
        val doneHit = customDone.ifEmpty { WATCH_DONE_RE.find(txt)?.value.orEmpty() }
        var loadingHit = ""
        for (m in WATCH_PCT_RE.findAll(txt)) {
            val v = m.groupValues.getOrNull(1)?.toIntOrNull() ?: -1
            if (v in 0..99) {
                loadingHit = m.value
                break
            }
        }
        if (loadingHit.isEmpty()) {
            loadingHit = WATCH_LOADING_WORD_RE.find(txt)?.value.orEmpty()
        }
        val stillActive = WATCH_LOADING_WORD_RE.containsMatchIn(txt)
        val isDone = doneHit.isNotEmpty() && (!stillActive || (customDone.isNotEmpty() && !loadingHit.contains("validat", true) && !loadingHit.contains("flash", true) && !loadingHit.contains("read", true) && !loadingHit.contains("think", true)))
        return WatchSignal(loadingHit.isNotEmpty(), loadingHit, permHit.isNotEmpty(), permHit, errHit.isNotEmpty(), errHit, isDone, doneHit)
    }

    private fun pruneAndroidHistoryForLongRun() {
        // Keep screenshots only on the last 2 turns so multi-hour runs never OOM or blow token limits
        var keptImages = 0
        for (i in history.lastIndex downTo 0) {
            val t = history[i]
            if (t.imageBase64 != null) {
                keptImages++
                if (keptImages > 2) {
                    history[i] = t.copy(imageBase64 = null)
                }
            }
        }
        if (history.size > 40) {
            val head = history.take(2)
            var tailStart = (history.size - 28).coerceAtLeast(2)
            while (tailStart < history.size - 4 && history[tailStart].role != "user") {
                tailStart++
            }
            val tail = history.subList(tailStart, history.size).toList()
            history.clear()
            history.addAll(head)
            history.add(ConversationTurn(role = "model", text = "[Earlier steps compacted cleanly for multi-hour endurance.]"))
            history.addAll(tail)
        }
    }

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

    private fun buildIdeaStepsJson(rawTask: String): JSONArray {
        val clean = rawTask.replace(Regex("\\s+"), " ").trim()
        val clauses = clean
            .split(Regex("\\b(?:and\\s+then|then|after\\s+that|next|finally)\\b|[;]+", RegexOption.IGNORE_CASE))
            .map { it.trim(' ', ',', '.') }
            .filter { it.length >= 4 }
        val titles: List<String> = when {
            clauses.size >= 3 -> clauses.take(4).map { it.replaceFirstChar { c -> c.uppercase() }.take(84) } +
                listOf("Verify result on screen")
            Regex("\\b(youtube|video|short|shorts|channel|watch|play|music|spotify)\\b", RegexOption.IGNORE_CASE).containsMatchIn(clean) -> listOf(
                "Check screen & open target app",
                "Search for requested channel or topic",
                "Open matching channel or result",
                "Select & open requested video or Short",
                "Verify live screen state"
            )
            Regex("\\b(write|create|edit|code|file|script|html|build)\\b", RegexOption.IGNORE_CASE).containsMatchIn(clean) -> listOf(
                "Inspect context & target files",
                "Plan implementation steps",
                "Create & update content",
                "Validate output & finish"
            )
            else -> {
                val shortGoal = if (clean.length > 52) clean.take(49) + "…" else clean.ifEmpty { "requested task" }
                listOf(
                    "Observe live 150f screen & UI elements",
                    "Open or focus target for: $shortGoal",
                    "Execute actions with animated cursor",
                    "Verify completion on screen"
                )
            }
        }
        val arr = JSONArray()
        titles.take(5).forEachIndexed { idx, t ->
            arr.put(
                JSONObject()
                    .put("id", "idea-${idx + 1}")
                    .put("title", t)
                    .put("status", if (idx == 0) "running" else "pending")
                    .put("isRetry", false)
            )
        }
        return arr
    }

    suspend fun runUserMessage(
        prompt: String,
        workMode: Boolean,
        workVisualMode: String = "photos",
        cursorSpeedMs: Long = 560L,
        touchTypingMode: String = "touch",
        priorMessages: JSONArray? = null,
        onStep: (String) -> Unit,
        onStepItem: ((JSONObject) -> Unit)? = null,
        onPlan: ((JSONObject) -> Unit)? = null,
        onWebSources: ((JSONObject) -> Unit)? = null
    ): String {
        stopped = false
        BriefAccessibilityService.configuredCursorSpeedMs = cursorSpeedMs.coerceIn(220L, 1400L)
        BriefAccessibilityService.configuredTouchTypingMode =
            if (touchTypingMode.equals("keyboard", ignoreCase = true)) "keyboard" else "touch"

        // Sync multi-turn conversation memory cleanly for this chat (including "no, open X instead of Y" redirects!)
        val redirectHints = mutableListOf<String>()
        if (priorMessages != null) {
            history.clear()
            val priorCount = (priorMessages.length() - 1).coerceAtLeast(0)
            val startIdx = (priorCount - 10).coerceAtLeast(0)
            for (i in startIdx until priorCount) {
                val m = priorMessages.optJSONObject(i) ?: continue
                val roleRaw = m.optString("role")
                val txt = m.optString("text").trim()
                if (txt.isEmpty()) continue
                history.add(
                    ConversationTurn(
                        role = if (roleRaw == "assistant" || roleRaw == "model") "model" else "user",
                        text = txt.take(6000)
                    )
                )
                if (roleRaw == "user" && Regex("\\b(no[,\\s]+(?:not|don'?t|open|use|go|click|pick|choose)|instead\\s+of|not\\s+that|wrong\\s+(?:one|tab|app|link|video|channel))\\b", RegexOption.IGNORE_CASE).containsMatchIn(txt)) {
                    redirectHints.add(txt.take(200))
                }
            }
        }
        if (Regex("\\b(no[,\\s]+(?:not|don'?t|open|use|go|click|pick|choose)|instead\\s+of|not\\s+that|wrong\\s+(?:one|tab|app|link|video|channel))\\b", RegexOption.IGNORE_CASE).containsMatchIn(prompt)) {
            redirectHints.add(prompt.take(200))
        }
        val redirectMemorySuffix = if (redirectHints.isNotEmpty()) {
            "\n[USER REDIRECT MEMORY — FOLLOW CALMLY & NEVER REPEAT REJECTED OPTION]: " + redirectHints.takeLast(3).joinToString(" | ")
        } else ""

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
        if (workMode) {
            val planSteps = buildIdeaStepsJson(prompt)
            val planLines = buildString {
                for (i in 0 until planSteps.length()) {
                    if (i > 0) append("\n")
                    append("${i + 1}. ${planSteps.getJSONObject(i).optString("title")}")
                }
            }
            onPlan?.invoke(
                JSONObject()
                    .put("plan", planLines)
                    .put("planSteps", planSteps)
            )
        }
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
            prompt + redirectMemorySuffix + formatUiSnapshotForAi(initialUi) +
                "\n[Calibrated 0..1000 HD screenshot attached. Execute the user's FULL multi-step goal step-by-step until completely finished on screen!]"
        } else {
            prompt + redirectMemorySuffix
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
        val maxSteps = if (workMode) 240 else if (thinking == ThinkingLevel.EXTRA) 6 else 4
        val workStartMs = System.currentTimeMillis()
        val maxWorkMs = 240L * 60L * 1000L // Up to 4 hours endurance (16–20+ min thorough work -> 4h max)
        val requiresMultiStepCompletion = workMode &&
            Regex("\\b(search|find|click|tap|channel|latest|video|short|shorts|watch|play|send|message|type|generate|render|download|install|flash|verify|claude|chatgpt|agent|rufus|etcher)\\b", RegexOption.IGNORE_CASE).containsMatchIn(prompt)

        var executedActionCount = 0
        var prematureFinishNudges = 0
        var stillLoadingNudges = 0
        var permissionGrantsCount = 0
        var lastRepeatedSig = ""
        var sameSigStreak = 0

        val wakeLock: PowerManager.WakeLock? = if (workMode) {
            runCatching {
                val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Brief:StayWatchWork")?.apply {
                    setReferenceCounted(false)
                    acquire(maxWorkMs)
                }
            }.getOrNull()
        } else null

        try {
            for (step in 1..maxSteps) {
                if (stopped) return "Stopped by user."
                if (workMode && System.currentTimeMillis() - workStartMs >= maxWorkMs) {
                    return "Reached maximum 4-hour endurance limit (${formatWatchElapsed(System.currentTimeMillis() - workStartMs)}). Please check screen state."
                }
                pruneAndroidHistoryForLongRun()
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
                    // Ultra-Patient Stay & Watch Guard: NEVER finish OR say "I'm still waiting" while Claude/ChatGPT/any AI or app is reading, loading, validating, or asking for permission!
                    if (workMode && stillLoadingNudges < 40 && BriefAccessibilityService.instance != null) {
                        val accNow = BriefAccessibilityService.instance!!
                        val checkUiNow = accNow.readScreenElements(150)
                        val uiSig = analyzeWatchText(extractUiTextForWatch(checkUiNow))
                        val impatientTxt = IMPATIENT_WAIT_TEXT_RE.containsMatchIn(res.text)
                        val hasPermToGrant = uiSig.hasPermissionPrompt && !uiSig.isDone && permissionGrantsCount < MAX_EXTERNAL_PERMISSION_GRANTS
                        if (hasPermToGrant || (uiSig.isLoading && !uiSig.isDone) || impatientTxt) {
                            stillLoadingNudges++
                            val wEmoji = pickWatchEmoji(stillLoadingNudges)
                            val wMsg = when {
                                hasPermToGrant -> "$wEmoji Permission prompt (${permissionGrantsCount + 1}/$MAX_EXTERNAL_PERMISSION_GRANTS) — granting & continuing…"
                                impatientTxt -> "$wEmoji Staying patient until real result arrives…"
                                else -> "$wEmoji Watching (${uiSig.loadingHit}) patiently…"
                            }
                            onStep(wMsg)
                            if (!isBgVisual) accNow.updateOverlayState(provider, wMsg)
                            val checkFrame = accNow.captureLiveVisionFrame(settleMaxMs = 700L)
                            val directive = if (hasPermToGrant) {
                                "[PERMISSION PROMPT DETECTED (${permissionGrantsCount + 1}/$MAX_EXTERNAL_PERMISSION_GRANTS)]: Tap Allow / Approve / Accept / Proceed / Open Folder NOW, then IMMEDIATELY call `watch_and_wait({\"reason\": \"waiting after permission\", \"max_wait_minutes\": 30})` — do NOT stop after 1 permission!"
                            } else {
                                "[PATIENT STAY & WATCH GUARD — DO NOT QUIT OR SAY 'I AM STILL WAITING']: Never send a reply saying you are still waiting! Call `watch_and_wait({\"reason\": \"${uiSig.loadingHit.ifEmpty { "active process" }}\", \"max_wait_minutes\": 30})` RIGHT NOW to stay quietly until the REAL result arrives, then TEST & verify it!"
                            }
                            history.add(
                                ConversationTurn(
                                    role = "user",
                                    text = directive + formatUiSnapshotForAi(checkUiNow),
                                    imageBase64 = checkFrame?.calibratedAiBase64
                                )
                            )
                            continue
                        }
                    }
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
                    if (tc.name in setOf("web_search", "fetch_url", "open_url")) {
                        val liveQ = tc.args.optString("query").ifEmpty { tc.args.optString("url") }
                        onWebSources?.invoke(
                            JSONObject()
                                .put("phase", "searching")
                                .put("query", liveQ)
                                .put("engine", "duckduckgo.com")
                                .put("sources", JSONArray())
                        )
                    }
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

                    val isPermTap = tc.name == "tap_element" &&
                        Regex("\\b(allow|approve|accept|permit|grant|trust|open\\s+folder|yes,\\s*proceed|while\\s+using|only\\s+this\\s+time)\\b", RegexOption.IGNORE_CASE)
                            .containsMatchIn(tc.args.optString("label"))
                    val sameLimit = when {
                        tc.name == "watch_and_wait" -> 24
                        isPermTap -> MAX_EXTERNAL_PERMISSION_GRANTS + 1
                        else -> 4
                    }
                    val unsolicitedBlockMsg: String? = if (tc.name == "open_app" || tc.name == "open_url") {
                        val targetText = tc.args.optString("name") + " " + tc.args.optString("url")
                        val userTextAll = buildString {
                            history.filter { it.role == "user" }.takeLast(6).forEach { append(it.text).append('\n') }
                            append(prompt)
                        }
                        val blockedAi = EXTERNAL_AI_GUARD_RULES.firstOrNull { (_, targetRe, userRe) ->
                            targetRe.containsMatchIn(targetText) && !userRe.containsMatchIn(userTextAll)
                        }
                        when {
                            blockedAi != null ->
                                "BLOCKED: The user did NOT ask you to open ${blockedAi.first}! YOU are Brief — do the thinking and work YOURSELF instead of opening another AI app or site."
                            tc.name == "open_url" &&
                                Regex("^https?://(?:www\\.)?(?:google\\.[a-z.]+/?(?:\\?|\\z|search)|bing\\.com/?(?:\\?|\\z|search)|duckduckgo\\.com/?(?:\\?|\\z))", RegexOption.IGNORE_CASE)
                                    .containsMatchIn(tc.args.optString("url").trim()) &&
                                !Regex("\\b(?:open\\s+(?:google|bing|duckduckgo)|google\\.com|bing\\.com|duckduckgo\\.com)\\b", RegexOption.IGNORE_CASE)
                                    .containsMatchIn(userTextAll) ->
                                "BLOCKED: Do NOT open random search-engine tabs! Use your silent built-in `web_search` and `fetch_url` tools instead."
                            else -> null
                        }
                    } else null
                    var out = if (unsolicitedBlockMsg != null) {
                        JSONObject().put("ok", false).put("blocked", true).put("error", unsolicitedBlockMsg).toString()
                    } else if (sameSigStreak >= sameLimit) {
                        JSONObject().put("error", "Repeated identical action $sameLimit times; try a different coordinate, tap_element, or swipe to scroll.").toString()
                    } else {
                        executeTool(tc, provider, isBgVisual, onStep)
                    }
                    if (isPermTap && !out.contains("\"error\"")) {
                        permissionGrantsCount++
                        val patched = runCatching { JSONObject(out) }.getOrElse { JSONObject().put("ok", true) }
                        patched.put("permission_grant_count", permissionGrantsCount)
                        patched.put("permission_grant_max", MAX_EXTERNAL_PERMISSION_GRANTS)
                        patched.put(
                            "next_step_reminder",
                            if (permissionGrantsCount >= MAX_EXTERNAL_PERMISSION_GRANTS) {
                                "Reached max $MAX_EXTERNAL_PERMISSION_GRANTS automatic permission grants — pause and ask the user if more permissions are needed."
                            } else {
                                "Granted permission #$permissionGrantsCount/$MAX_EXTERNAL_PERMISSION_GRANTS. Immediately call watch_and_wait({\"reason\": \"waiting after permission\", \"max_wait_minutes\": 30}) to stay patiently for the next permission or real final result!"
                            }
                        )
                        out = patched.toString()
                    }

                    if (tc.name in setOf("web_search", "fetch_url", "open_url")) {
                        runCatching {
                            val parsed = JSONObject(out)
                            if (tc.name == "web_search") {
                                val resArr = parsed.optJSONArray("results") ?: JSONArray()
                                if (resArr.length() > 0) {
                                    onWebSources?.invoke(
                                        JSONObject()
                                            .put("phase", "done")
                                            .put("query", parsed.optString("query", tc.args.optString("query")))
                                            .put("engine", parsed.optString("engine", "duckduckgo.com"))
                                            .put("sources", resArr)
                                    )
                                }
                            } else {
                                val vUrl = parsed.optString("url").ifEmpty { tc.args.optString("url") }
                                if (vUrl.startsWith("http")) {
                                    val dom = android.net.Uri.parse(vUrl).host?.lowercase()?.removePrefix("www.").orEmpty()
                                    val vArr = JSONArray().put(
                                        JSONObject()
                                            .put("title", parsed.optString("title").ifEmpty { dom.ifEmpty { vUrl } })
                                            .put("url", vUrl)
                                            .put("domain", dom)
                                            .put("engine", dom)
                                            .put("visited", true)
                                    )
                                    onWebSources?.invoke(
                                        JSONObject()
                                            .put("phase", "done")
                                            .put("query", parsed.optString("title").ifEmpty { dom.ifEmpty { vUrl } })
                                            .put("engine", dom)
                                            .put("visited", true)
                                            .put("sources", vArr)
                                    )
                                }
                            }
                        }
                    }

                    if (tc.name in setOf("open_app", "open_url", "tap", "tap_element", "double_tap", "type_text", "press_enter", "swipe")) {
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
            runCatching { if (wakeLock?.isHeld == true) wakeLock.release() }
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
            "press_enter" -> "Looking for & pressing Enter / Search"
            "swipe" -> "Scrolling screen (${a.optInt("y1")} → ${a.optInt("y2")})"
            "press_back" -> "Pressing Back"
            "press_home" -> "Going Home"
            "web_search" -> "Searching web: ${a.optString("query").take(28)}"
            "watch_and_wait" -> "👀🍿 Watching: ${a.optString("reason", "progress").take(34)}"
            "wait_ms" -> "👀☕ Waiting ${(a.optLong("ms", 1000L) / 1000L).coerceAtLeast(1L)}s"
            else -> tc.name
        }
    }

    private fun summarizeResult(raw: String): String {
        val obj = runCatching { JSONObject(raw) }.getOrNull() ?: return raw.take(64)
        if (obj.has("error")) return "Error: ${obj.optString("error").take(60)}"
        if (obj.has("detail")) return obj.optString("detail").take(72)
        if (obj.has("outcome")) return "${obj.optString("outcome")} (${obj.optString("watched_duration")})"
        return if (obj.optBoolean("ok", true)) "OK" else "Retry needed"
    }

    private fun startOverlayIfAllowed(provider: ProviderId, status: String) {
        BriefAccessibilityService.onUserStopRequested = { stop() }
        BriefAccessibilityService.instance?.showOverlay(provider, status)
    }

    private suspend fun executeTool(
        tc: ToolCallSpec,
        provider: ProviderId,
        isBgVisual: Boolean = false,
        onStep: ((String) -> Unit)? = null
    ): String {
        val a = tc.args
        return when (tc.name) {
            "web_search" -> aiClient.webSearch(a.optString("query"))
            "fetch_url" -> aiClient.fetchUrlText(a.optString("url"))
            "wait_ms" -> {
                val totalMs = a.optLong("ms", 1200L).coerceIn(150L, 60_000L)
                val reason = a.optString("reason", "loading").take(28)
                val started = System.currentTimeMillis()
                val endAt = started + totalMs
                var tick = 0
                while (System.currentTimeMillis() < endAt) {
                    if (stopped) return JSONObject().put("error", "Stopped by user.").toString()
                    val elap = System.currentTimeMillis() - started
                    if (elap >= 1500L && tick % 4 == 0) {
                        val lbl = "${pickWatchEmoji(tick / 4)} Waiting ($reason)… ${formatWatchElapsed(elap)}"
                        onStep?.invoke(lbl)
                        if (!isBgVisual) BriefAccessibilityService.instance?.updateOverlayState(provider, lbl)
                    }
                    delay(250L)
                    tick++
                }
                JSONObject().put("ok", true).put("waited_ms", totalMs).toString()
            }
            "watch_and_wait" -> {
                val reason = a.optString("reason", "process").trim().take(34).ifEmpty { "process" }
                val reqMin = a.optDouble("max_wait_minutes", 30.0).coerceIn(1.0, 240.0)
                val cycleMs = minOf((reqMin * 60_000.0).toLong(), 30L * 60_000L)
                val baseIntervalMs = (a.optDouble("check_interval_sec", 8.0).coerceIn(3.0, 45.0) * 1000.0).toLong()
                val doneKws = buildList {
                    val arr = a.optJSONArray("done_keywords")
                    if (arr != null) for (i in 0 until arr.length()) add(arr.optString(i))
                }
                val errKws = buildList {
                    val arr = a.optJSONArray("error_keywords")
                    if (arr != null) for (i in 0 until arr.length()) add(arr.optString(i))
                }
                val started = System.currentTimeMillis()
                val deadline = started + cycleMs
                var emojiIdx = (started % WATCH_SNACK_EMOJIS.size).toInt()
                var lastEmojiSwap = started
                var checks = 0
                var sawActivity = false
                var settledSince = 0L
                var lastUiText = ""
                var lastLoadingHit = ""

                fun paintWatch(extra: String) {
                    val now = System.currentTimeMillis()
                    if (now - lastEmojiSwap >= 14_000L) {
                        emojiIdx = (emojiIdx + 1) % WATCH_SNACK_EMOJIS.size
                        lastEmojiSwap = now
                    }
                    val emoji = pickWatchEmoji(emojiIdx)
                    val elap = formatWatchElapsed(now - started)
                    val lbl = "$emoji Watching $reason${if (extra.isNotEmpty()) " · $extra" else ""} ($elap)"
                    onStep?.invoke(lbl)
                    if (!isBgVisual) {
                        BriefAccessibilityService.instance?.updateOverlayState(provider, lbl)
                    }
                }

                paintWatch("patiently")
                while (System.currentTimeMillis() < deadline) {
                    if (stopped) return JSONObject().put("error", "Stopped by user.").toString()
                    val elapsedNow = System.currentTimeMillis() - started
                    val intervalMs = if (elapsedNow > 240_000L) minOf(22_000L, (baseIntervalMs * 1.5).toLong()) else baseIntervalMs
                    val nextAt = minOf(deadline, System.currentTimeMillis() + intervalMs)
                    while (System.currentTimeMillis() < nextAt) {
                        if (stopped) return JSONObject().put("error", "Stopped by user.").toString()
                        paintWatch(lastLoadingHit)
                        delay(minOf(1000L, (nextAt - System.currentTimeMillis()).coerceAtLeast(200L)))
                    }
                    checks++
                    val acc = BriefAccessibilityService.instance
                    val uiObj = acc?.readScreenElements(150)
                    val uiTxt = extractUiTextForWatch(uiObj)
                    val changed = uiTxt.isNotEmpty() && uiTxt != lastUiText
                    lastUiText = uiTxt
                    val sig = analyzeWatchText(uiTxt, doneKws, errKws)
                    if (changed || sig.isLoading) {
                        sawActivity = true
                        settledSince = 0L
                    }
                    lastLoadingHit = if (sig.isLoading) sig.loadingHit.take(16) else ""

                    if (sig.hasPermissionPrompt && !sig.isDone) {
                        return JSONObject()
                            .put("ok", true)
                            .put("outcome", "permission_prompt")
                            .put("matched", sig.permissionHit)
                            .put("reason", reason)
                            .put("watched_duration", formatWatchElapsed(System.currentTimeMillis() - started))
                            .put("checks", checks)
                            .put("detail", "Permission prompt detected (\"${sig.permissionHit}\") — tap Allow/Approve/Open Folder and IMMEDIATELY call watch_and_wait again (supports up to $MAX_EXTERNAL_PERMISSION_GRANTS permission grants)!")
                            .toString()
                    }
                    if (sig.hasError && !sig.isDone) {
                        return JSONObject()
                            .put("ok", false)
                            .put("outcome", "alert_detected")
                            .put("matched", sig.errorHit)
                            .put("reason", reason)
                            .put("watched_duration", formatWatchElapsed(System.currentTimeMillis() - started))
                            .put("checks", checks)
                            .put("detail", "Error/Failure detected (\"${sig.errorHit}\") — inspect screen and fix or report honestly!")
                            .toString()
                    }
                    if (sig.isDone && !sig.isLoading && (System.currentTimeMillis() - started) >= 5000L) {
                        return JSONObject()
                            .put("ok", true)
                            .put("outcome", "completed")
                            .put("matched", sig.doneHit)
                            .put("reason", reason)
                            .put("watched_duration", formatWatchElapsed(System.currentTimeMillis() - started))
                            .put("checks", checks)
                            .put("detail", "Finished (\"${sig.doneHit}\") — NOW TEST & VERIFY the actual final output before declaring done!")
                            .toString()
                    }
                    // Truly patient: require 3–4 full minutes (180s–240s) of total stillness & zero loading indicators!
                    if (!sig.isLoading && !changed) {
                        if (settledSince == 0L) settledSince = System.currentTimeMillis()
                        val stillMs = System.currentTimeMillis() - settledSince
                        if (stillMs >= (if (sawActivity) 180_000L else 240_000L)) {
                            return JSONObject()
                                .put("ok", true)
                                .put("outcome", "settled_verify")
                                .put("reason", reason)
                                .put("watched_duration", formatWatchElapsed(System.currentTimeMillis() - started))
                                .put("checks", checks)
                                .put("detail", "Screen stayed completely still for ${formatWatchElapsed(stillMs)}. Inspect closely: test & verify if finished, tap permission if waiting, or call watch_and_wait again WITHOUT saying 'I am still waiting'!")
                                .toString()
                        }
                    }
                }
                JSONObject()
                    .put("ok", true)
                    .put("outcome", "checkpoint")
                    .put("reason", reason)
                    .put("watched_duration", formatWatchElapsed(System.currentTimeMillis() - started))
                    .put("checks", checks)
                    .put("detail", "Silent 30m checkpoint — DO NOT say 'I am still waiting' in chat! Call watch_and_wait again if still running (up to 4h total), or test & verify if done.")
                    .toString()
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
            "press_enter" -> {
                val acc = BriefAccessibilityService.instance
                    ?: return JSONObject().put("error", "Accessibility Service is off.").toString()
                val (ok, msg) = acc.pressEnterSmart()
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
            "You are Brief on Android (Chat Mode). Answer clearly, quickly, and accurately. Use web_search and fetch_url whenever current or live web research helps. CALM REDIRECT MEMORY: Whenever the user says 'no, open/do X instead of Y' or corrects your path, remember BOTH what NOT to repeat (Y) and the new target (X), stay calm without confusion, and follow X directly.$extraHint"
        } else {
            """You are Brief on Android (Work Mode — Smart 150-Frame Vision Phone & Tablet Agent).
You have LIVE calibrated HD screenshots (0..1000 x 0..1000 coordinate ruler on top/left edges, where 0,0 is top-left and 1000,1000 is bottom-right) PLUS a 150-node interactive UI element map on EVERY step.

CRITICAL EXECUTION RULES (BE SMART, SELF-RELIANT, THOROUGH & NEVER QUIT EARLY):
0. ABSOLUTE SELF-RELIANCE — DO THE WORK YOURSELF (NEVER OPEN CLAUDE/CHATGPT OR RANDOM TABS): YOU are Brief! Solve the user's request yourself using your own brain and direct tools (`web_search`, `fetch_url`, app controls). NEVER open Claude, ChatGPT, Gemini, Perplexity, Copilot, or random browser tabs/apps unless the user EXPLICITLY named them in their message!
1. COMPLETE EVERY STEP OF THE USER'S GOAL: Never stop right after opening an app! If the user says "open YouTube, search MrBeast, click the Beast channel icon, and open/give his latest Short or latest video":
   - Step A: Call `open_app({"name": "YouTube"})`.
   - Step B: Tap the Search icon (`tap_element({"label": "Search"})` or `tap` on the magnifying glass in the top bar).
   - Step C: Call `type_text({"text": "MrBeast", "submit": true})` so the search actually executes!
   - Step D: Inspect the search results carefully! Look for the official channel row / circular Beast avatar icon (e.g. `@MrBeast` / channel header, NOT an ad or random clip) and tap it to open the channel page.
   - Step E: On the channel page, tap the `Videos` or `Shorts` tab chip, inspect the newest upload (check relative timestamps like "hours ago" / "days ago" and skip older pinned items if needed), and tap it so it plays on screen (or report its exact title & details as asked).
2. SMART TYPING & FINDING THE ENTER / SEARCH BUTTON ACROSS ALL ANDROID SKINS (Samsung One UI, Oppo/Realme ColorOS, Honor MagicOS, Xiaomi HyperOS, Gboard):
   - Always tap the input/search box first so it focuses and opens the keyboard, then call `type_text({"text": "...", "submit": true})`.
   - Every Android OS skin places its Enter / Search / Go / Send key in a different spot! ALWAYS LOOK at the live 150f screenshot AND check `[KEYBOARD_ENTER_KEY]` in `[Live 150-Node Interactive UI Map]`! If after `type_text` the keyboard is still open and search hasn't submitted yet, immediately call `press_enter({})` OR `tap` on the exact visible magnifying-glass / arrow / Search / Enter key shown on the keyboard or matching suggestion row!
3. PREFER PRECISION: Use the `[Live 150-Node Interactive UI Map]` coordinates or `tap_element` whenever a button/tab/channel has a clear label, and use the calibrated `0..1000` screenshot grid for visual icons/thumbnails/avatars.
4. IF SOMETHING IS OFF-SCREEN: Use `swipe` (`x1=500, y1=760, x2=500, y2=260`) to scroll down smoothly and inspect new items.
5. CALM USER REDIRECT & CONTEXT MEMORY ("NO, OPEN X INSTEAD OF Y"): Remember user corrections across the entire chat! Whenever the user says "no, open X instead of Y" or redirects you, remember NOT to open/repeat Y, never get confused or flustered, and pivot straight to X!
6. ULTRA-PATIENT STAY, WATCH, MULTI-PERMISSION (3–16 GRANTS) & REAL-TEST RULE (ONLY FOR ALREADY-RUNNING PROCESSES — UP TO 4 HOURS MAX, ALL 4 MODELS): Whenever an app, download, installer, video generator, OR another AI explicitly requested by the user is ALREADY loading/working, NEVER quit early and NEVER reply "I'm still waiting"! Stay quietly inside `watch_and_wait({"reason": "...", "max_wait_minutes": 30})` (up to 240 min = 4h, showing cute 👀🍿 / 👀🍕 / 👀☕ cursor status). When an active app asks for permission (3–4 commonly, up to 16 max!), tap Allow/Approve/Accept/Open Folder and IMMEDIATELY call `watch_and_wait` again until the REAL final result arrives — then TEST IT and honestly tell the user whether it worked or failed!
7. SAFETY: Pause and ask the user only before irreversible payments, password entry, or permanent deletion (or if an app loops past 16 permission prompts).$extraHint"""
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
                "Type text into the focused/visible input or search bar (automatically uses smart hybrid keyboard/touch input). Set submit=true (default) to locate and press the OS Search/Enter button automatically!",
                JSONObject()
                    .put("text", JSONObject().put("type", "string"))
                    .put("submit", JSONObject().put("type", "boolean").put("description", "True to press Search/Enter after typing")),
                listOf("text")
            )
            addTool(
                "press_enter",
                "Inspect the live keyboard (One UI, ColorOS, MagicOS, Gboard, SwiftKey) and search bar to locate and tap the real Enter / Search / Go / Send button.",
                JSONObject()
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
                "Wait briefly (150..60000 ms) for quick page/UI loading. For anything longer or any loading/generating/downloading/AI agent process, use watch_and_wait instead.",
                JSONObject()
                    .put("ms", JSONObject().put("type", "integer"))
                    .put("reason", JSONObject().put("type", "string")),
                listOf("ms")
            )
            addTool(
                "watch_and_wait",
                "Stay and actively watch a loading app, download, installer, AI video generator, or another AI agent until it finishes, errors/denies, or hits a 10-min checkpoint (supports up to 240 minutes = 4 hours total with cute 👀🍿 / 👀🍕 / 👀☕ cursor watching status).",
                JSONObject()
                    .put("reason", JSONObject().put("type", "string").put("description", "What you are watching (e.g. 'AI video generation', 'download & install', 'other AI agent reply')"))
                    .put("max_wait_minutes", JSONObject().put("type", "number").put("description", "Max minutes to watch (1..240, default 15)"))
                    .put("check_interval_sec", JSONObject().put("type", "number").put("description", "Seconds between checks (3..45, default 8)"))
                    .put("done_keywords", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string")))
                    .put("error_keywords", JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))),
                listOf("reason")
            )
        }
        return arr
    }
}
