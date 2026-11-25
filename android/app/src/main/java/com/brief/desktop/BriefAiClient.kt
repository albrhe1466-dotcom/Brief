package com.brief.desktop

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class ToolCallSpec(
    val id: String,
    val name: String,
    val args: JSONObject,
    val thoughtSignature: String? = null
)

data class AiTurnResult(
    val text: String,
    val toolCalls: List<ToolCallSpec> = emptyList(),
    val rawPartsJson: JSONArray? = null
)

data class ConversationTurn(
    val role: String, // "user", "model", "tool_results"
    val text: String = "",
    val imageBase64: String? = null,
    val modelPartsJson: JSONArray? = null,
    val toolCalls: List<ToolCallSpec> = emptyList(),
    val toolResults: List<Pair<ToolCallSpec, String>> = emptyList()
)

class BriefAiClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(18, TimeUnit.SECONDS)
        .readTimeout(85, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    @Volatile
    private var discoveredGeminiModels: List<String> = emptyList()

    fun validateAndSetup(provider: ProviderId, apiKey: String): Pair<Boolean, String> {
        val k = apiKey.trim()
        if (k.isEmpty()) return false to "API key cannot be empty."
        return when (provider) {
            ProviderId.GEMINI -> validateGemini(k)
            ProviderId.OPENAI -> validateOpenAiCompat("https://api.openai.com/v1/models", k, null)
            ProviderId.OPENROUTER -> validateOpenAiCompat("https://openrouter.ai/api/v1/models", k, "https://locally.app")
            ProviderId.ANTHROPIC -> validateAnthropic(k)
        }
    }

    private fun validateGemini(key: String): Pair<Boolean, String> {
        val req = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${URLEncoder.encode(key, "UTF-8")}")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val err = runCatching { JSONObject(body).optJSONObject("error")?.optString("message") }.getOrNull()
                return false to ("Gemini rejected key (HTTP ${resp.code}): ${err ?: body.take(140)}")
            }
            val arr = JSONObject(body).optJSONArray("models") ?: JSONArray()
            val found = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val name = arr.optJSONObject(i)?.optString("name").orEmpty().removePrefix("models/")
                if (name.isNotEmpty()) found.add(name)
            }
            discoveredGeminiModels = found
            return true to "Gemini Key Verified (${found.size} models discovered)."
        }
    }

    private fun validateOpenAiCompat(url: String, key: String, referer: String?): Pair<Boolean, String> {
        val rb = Request.Builder().url(url).addHeader("Authorization", "Bearer $key")
        if (referer != null) {
            rb.addHeader("HTTP-Referer", referer).addHeader("X-Title", "LOCALLY")
        }
        http.newCall(rb.get().build()).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val err = runCatching { JSONObject(body).optJSONObject("error")?.optString("message") }.getOrNull()
                return false to ("Key rejected (HTTP ${resp.code}): ${err ?: body.take(140)}")
            }
            return true to "API Key Verified & Saved."
        }
    }

    private fun validateAnthropic(key: String): Pair<Boolean, String> {
        val req = Request.Builder()
            .url("https://api.anthropic.com/v1/models?limit=50")
            .addHeader("x-api-key", key)
            .addHeader("anthropic-version", "2023-06-01")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val err = runCatching { JSONObject(body).optJSONObject("error")?.optString("message") }.getOrNull()
                return false to ("Claude key rejected (HTTP ${resp.code}): ${err ?: body.take(140)}")
            }
            return true to "Claude API Key Verified & Saved."
        }
    }

    fun generate(
        provider: ProviderId,
        apiKey: String,
        modelId: String,
        thinking: ThinkingLevel,
        systemPrompt: String,
        history: List<ConversationTurn>,
        toolDefs: JSONArray
    ): AiTurnResult {
        val candidates = ProviderModels.resolveRuntimeCandidates(
            provider,
            modelId,
            if (provider == ProviderId.GEMINI) discoveredGeminiModels else emptyList()
        )
        var lastError: Exception? = null
        for (cand in candidates) {
            try {
                return when (provider) {
                    ProviderId.GEMINI -> callGemini(apiKey, cand, thinking, systemPrompt, history, toolDefs)
                    ProviderId.OPENAI -> callOpenAi(apiKey, cand, thinking, systemPrompt, history, toolDefs)
                    ProviderId.OPENROUTER -> callOpenRouter(apiKey, cand, thinking, systemPrompt, history, toolDefs)
                    ProviderId.ANTHROPIC -> callAnthropic(apiKey, cand, thinking, systemPrompt, history, toolDefs)
                }
            } catch (e: HttpStatusException) {
                lastError = e
                if (e.code == 401 || e.code == 403 || e.code == 429) throw e
            } catch (e: Exception) {
                lastError = e
                throw e
            }
        }
        throw lastError ?: IllegalStateException("No available model endpoints responded.")
    }

    private fun callGemini(
        apiKey: String,
        model: String,
        thinking: ThinkingLevel,
        systemPrompt: String,
        history: List<ConversationTurn>,
        toolDefs: JSONArray
    ): AiTurnResult {
        val contents = JSONArray()
        for (turn in history) {
            when (turn.role) {
                "user" -> {
                    val parts = JSONArray()
                    if (turn.text.isNotEmpty()) parts.put(JSONObject().put("text", turn.text))
                    if (!turn.imageBase64.isNullOrEmpty()) {
                        parts.put(
                            JSONObject().put(
                                "inlineData",
                                JSONObject().put("mimeType", "image/jpeg").put("data", turn.imageBase64)
                            )
                        )
                    }
                    contents.put(JSONObject().put("role", "user").put("parts", parts))
                }
                "model" -> {
                    val parts = turn.modelPartsJson ?: JSONArray().apply {
                        if (turn.text.isNotEmpty()) put(JSONObject().put("text", turn.text))
                    }
                    contents.put(JSONObject().put("role", "model").put("parts", parts))
                }
                "tool_results" -> {
                    val parts = JSONArray()
                    for ((call, resultJson) in turn.toolResults) {
                        val respObj = runCatching { JSONObject(resultJson) }.getOrElse {
                            JSONObject().put("result", resultJson)
                        }
                        parts.put(
                            JSONObject().put(
                                "functionResponse",
                                JSONObject().put("name", call.name).put("response", respObj)
                            )
                        )
                    }
                    contents.put(JSONObject().put("role", "user").put("parts", parts))
                }
            }
        }

        val genCfg = JSONObject()
        val lowerModel = model.lowercase()
        val isGemini3Plus = lowerModel.contains("gemini-3") || lowerModel.contains("gemini-4")
        val isGemini25 = lowerModel.contains("gemini-2.5")
        if (isGemini3Plus) {
            val isLite = lowerModel.contains("lite")
            val mappedLevel = when {
                isLite && (thinking == ThinkingLevel.LOW || thinking == ThinkingLevel.MEDIUM) -> "MINIMAL"
                thinking == ThinkingLevel.LOW -> "LOW"
                thinking == ThinkingLevel.MEDIUM -> "MEDIUM"
                else -> "HIGH"
            }
            genCfg.put("thinkingConfig", JSONObject().put("thinkingLevel", mappedLevel))
        } else if (isGemini25) {
            val budget = when (thinking) {
                ThinkingLevel.LOW -> 0
                ThinkingLevel.MEDIUM -> 1024
                ThinkingLevel.HIGH -> 4096
                ThinkingLevel.EXTRA -> 8192
            }
            genCfg.put("thinkingConfig", JSONObject().put("thinkingBudget", budget))
        }

        val payload = JSONObject().apply {
            put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", systemPrompt))))
            put("contents", contents)
            put("generationConfig", genCfg)
            if (toolDefs.length() > 0) {
                put("tools", JSONArray().put(JSONObject().put("functionDeclarations", toolDefs)))
            }
        }

        val req = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=${URLEncoder.encode(apiKey, "UTF-8")}")
            .post(payload.toString().toRequestBody(jsonMedia))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val msg = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }.getOrNull()
                throw HttpStatusException(resp.code, msg ?: "HTTP ${resp.code}: ${raw.take(180)}")
            }
            val json = JSONObject(raw)
            val cand = json.optJSONArray("candidates")?.optJSONObject(0)
            val parts = cand?.optJSONObject("content")?.optJSONArray("parts") ?: JSONArray()
            val sb = StringBuilder()
            val calls = mutableListOf<ToolCallSpec>()
            for (i in 0 until parts.length()) {
                val p = parts.optJSONObject(i) ?: continue
                if (p.optBoolean("thought", false)) continue
                val t = p.optString("text")
                if (t.isNotEmpty()) sb.append(t)
                val fc = p.optJSONObject("functionCall")
                if (fc != null) {
                    val sig = p.optString("thoughtSignature").takeIf { it.isNotEmpty() }
                    calls.add(
                        ToolCallSpec(
                            id = "g_${System.currentTimeMillis()}_$i",
                            name = fc.optString("name"),
                            args = fc.optJSONObject("args") ?: JSONObject(),
                            thoughtSignature = sig
                        )
                    )
                }
            }
            return AiTurnResult(sb.toString().trim(), calls, parts)
        }
    }

    private fun callOpenAi(
        apiKey: String,
        model: String,
        thinking: ThinkingLevel,
        systemPrompt: String,
        history: List<ConversationTurn>,
        toolDefs: JSONArray
    ): AiTurnResult = callOpenAiCompatible(
        url = "https://api.openai.com/v1/chat/completions",
        apiKey = apiKey,
        model = model,
        thinking = thinking,
        systemPrompt = systemPrompt,
        history = history,
        toolDefs = toolDefs,
        isOpenRouter = false
    )

    private fun callOpenRouter(
        apiKey: String,
        model: String,
        thinking: ThinkingLevel,
        systemPrompt: String,
        history: List<ConversationTurn>,
        toolDefs: JSONArray
    ): AiTurnResult = callOpenAiCompatible(
        url = "https://openrouter.ai/api/v1/chat/completions",
        apiKey = apiKey,
        model = model,
        thinking = thinking,
        systemPrompt = systemPrompt,
        history = history,
        toolDefs = toolDefs,
        isOpenRouter = true
    )

    private fun callOpenAiCompatible(
        url: String,
        apiKey: String,
        model: String,
        thinking: ThinkingLevel,
        systemPrompt: String,
        history: List<ConversationTurn>,
        toolDefs: JSONArray,
        isOpenRouter: Boolean
    ): AiTurnResult {
        val msgs = JSONArray()
        msgs.put(JSONObject().put("role", "system").put("content", systemPrompt))
        for (turn in history) {
            when (turn.role) {
                "user" -> {
                    if (turn.imageBase64.isNullOrEmpty()) {
                        msgs.put(JSONObject().put("role", "user").put("content", turn.text))
                    } else {
                        val content = JSONArray().apply {
                            if (turn.text.isNotEmpty()) put(JSONObject().put("type", "text").put("text", turn.text))
                            put(
                                JSONObject().put("type", "image_url").put(
                                    "image_url",
                                    JSONObject().put("url", "data:image/jpeg;base64,${turn.imageBase64}")
                                )
                            )
                        }
                        msgs.put(JSONObject().put("role", "user").put("content", content))
                    }
                }
                "model" -> {
                    val msgObj = JSONObject().put("role", "assistant")
                    msgObj.put("content", turn.text.ifEmpty { JSONObject.NULL })
                    if (turn.toolCalls.isNotEmpty()) {
                        val tArr = JSONArray()
                        for (tc in turn.toolCalls) {
                            tArr.put(
                                JSONObject().apply {
                                    put("id", tc.id)
                                    put("type", "function")
                                    put("function", JSONObject().put("name", tc.name).put("arguments", tc.args.toString()))
                                }
                            )
                        }
                        msgObj.put("tool_calls", tArr)
                    }
                    msgs.put(msgObj)
                }
                "tool_results" -> {
                    for ((tc, res) in turn.toolResults) {
                        msgs.put(
                            JSONObject().apply {
                                put("role", "tool")
                                put("tool_call_id", tc.id)
                                put("content", res)
                            }
                        )
                    }
                }
            }
        }

        val body = JSONObject().apply {
            put("model", model)
            put("messages", msgs)
            put("stream", false)
            if (toolDefs.length() > 0) {
                val oaiTools = JSONArray()
                for (i in 0 until toolDefs.length()) {
                    val fd = toolDefs.optJSONObject(i) ?: continue
                    oaiTools.put(
                        JSONObject().put("type", "function").put(
                            "function",
                            JSONObject().apply {
                                put("name", fd.optString("name"))
                                put("description", fd.optString("description"))
                                put("parameters", fd.optJSONObject("parameters") ?: JSONObject().put("type", "object").put("properties", JSONObject()))
                            }
                        )
                    )
                }
                put("tools", oaiTools)
            }
            if (isOpenRouter && !model.contains("lite", true) && !model.contains("haiku", true) && !model.contains("luna", true)) {
                val eff = when (thinking) {
                    ThinkingLevel.LOW -> "low"
                    ThinkingLevel.HIGH, ThinkingLevel.EXTRA -> "high"
                    ThinkingLevel.MEDIUM -> "medium"
                }
                put("reasoning", JSONObject().put("effort", eff))
            }
        }

        val rb = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $apiKey")
            .post(body.toString().toRequestBody(jsonMedia))
        if (isOpenRouter) {
            rb.addHeader("HTTP-Referer", "https://locally.app").addHeader("X-Title", "LOCALLY")
        }

        http.newCall(rb.build()).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val msg = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }.getOrNull()
                throw HttpStatusException(resp.code, msg ?: "HTTP ${resp.code}: ${raw.take(180)}")
            }
            val json = JSONObject(raw)
            val m = json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message") ?: JSONObject()
            val txt = if (m.isNull("content")) "" else m.optString("content", "")
            val calls = mutableListOf<ToolCallSpec>()
            val tcs = m.optJSONArray("tool_calls") ?: JSONArray()
            for (i in 0 until tcs.length()) {
                val tc = tcs.optJSONObject(i) ?: continue
                val fn = tc.optJSONObject("function") ?: continue
                val args = runCatching { JSONObject(fn.optString("arguments", "{}")) }.getOrElse { JSONObject() }
                calls.add(ToolCallSpec(tc.optString("id", "tc_$i"), fn.optString("name"), args))
            }
            return AiTurnResult(txt.trim(), calls)
        }
    }

    private fun callAnthropic(
        apiKey: String,
        model: String,
        thinking: ThinkingLevel,
        systemPrompt: String,
        history: List<ConversationTurn>,
        toolDefs: JSONArray
    ): AiTurnResult {
        val msgs = JSONArray()
        for (turn in history) {
            when (turn.role) {
                "user" -> {
                    val content = JSONArray()
                    if (!turn.imageBase64.isNullOrEmpty()) {
                        content.put(
                            JSONObject().put("type", "image").put(
                                "source",
                                JSONObject().put("type", "base64").put("media_type", "image/jpeg").put("data", turn.imageBase64)
                            )
                        )
                    }
                    if (turn.text.isNotEmpty()) content.put(JSONObject().put("type", "text").put("text", turn.text))
                    msgs.put(JSONObject().put("role", "user").put("content", content))
                }
                "model" -> {
                    val content = JSONArray()
                    if (turn.text.isNotEmpty()) content.put(JSONObject().put("type", "text").put("text", turn.text))
                    for (tc in turn.toolCalls) {
                        content.put(
                            JSONObject().apply {
                                put("type", "tool_use")
                                put("id", tc.id)
                                put("name", tc.name)
                                put("input", tc.args)
                            }
                        )
                    }
                    msgs.put(JSONObject().put("role", "assistant").put("content", content))
                }
                "tool_results" -> {
                    val content = JSONArray()
                    for ((tc, res) in turn.toolResults) {
                        content.put(
                            JSONObject().apply {
                                put("type", "tool_result")
                                put("tool_use_id", tc.id)
                                put("content", res)
                            }
                        )
                    }
                    msgs.put(JSONObject().put("role", "user").put("content", content))
                }
            }
        }

        val body = JSONObject().apply {
            put("model", model)
            put("system", systemPrompt)
            put("max_tokens", if (thinking == ThinkingLevel.EXTRA) 8192 else 4096)
            put("messages", msgs)
            if (toolDefs.length() > 0) {
                val aTools = JSONArray()
                for (i in 0 until toolDefs.length()) {
                    val fd = toolDefs.optJSONObject(i) ?: continue
                    aTools.put(
                        JSONObject().apply {
                            put("name", fd.optString("name"))
                            put("description", fd.optString("description"))
                            put("input_schema", fd.optJSONObject("parameters") ?: JSONObject().put("type", "object").put("properties", JSONObject()))
                        }
                    )
                }
                put("tools", aTools)
            }
        }

        val req = Request.Builder()
            .url("https://api.anthropic.com/v1/messages")
            .addHeader("x-api-key", apiKey)
            .addHeader("anthropic-version", "2023-06-01")
            .post(body.toString().toRequestBody(jsonMedia))
            .build()

        http.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val msg = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }.getOrNull()
                throw HttpStatusException(resp.code, msg ?: "HTTP ${resp.code}: ${raw.take(180)}")
            }
            val json = JSONObject(raw)
            val content = json.optJSONArray("content") ?: JSONArray()
            val sb = StringBuilder()
            val calls = mutableListOf<ToolCallSpec>()
            for (i in 0 until content.length()) {
                val blk = content.optJSONObject(i) ?: continue
                when (blk.optString("type")) {
                    "text" -> sb.append(blk.optString("text"))
                    "tool_use" -> calls.add(
                        ToolCallSpec(
                            id = blk.optString("id", "tu_$i"),
                            name = blk.optString("name"),
                            args = blk.optJSONObject("input") ?: JSONObject()
                        )
                    )
                }
            }
            return AiTurnResult(sb.toString().trim(), calls)
        }
    }

    fun webSearch(query: String): String {
        val url = "https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(query, "UTF-8")
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")
            .get()
            .build()
        return try {
            http.newCall(req).execute().use { resp ->
                val html = resp.body?.string().orEmpty()
                val titleRegex = Regex("""<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>""", RegexOption.DOT_MATCHES_ALL)
                val snipRegex = Regex("""<a[^>]*class="result__snippet"[^>]*>(.*?)</a>""", RegexOption.DOT_MATCHES_ALL)
                val titles = titleRegex.findAll(html).take(6).toList()
                val snips = snipRegex.findAll(html).take(6).toList()
                val results = JSONArray()
                for (i in titles.indices) {
                    val m = titles[i]
                    val cleanTitle = m.groupValues[2].replace(Regex("<[^>]+>"), "").trim()
                    val cleanUrl = m.groupValues[1]
                    val cleanSnip = snips.getOrNull(i)?.groupValues?.getOrNull(1)?.replace(Regex("<[^>]+>"), "")?.trim().orEmpty()
                    results.put(JSONObject().put("title", cleanTitle).put("url", cleanUrl).put("snippet", cleanSnip))
                }
                JSONObject().put("query", query).put("results", results).toString()
            }
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Search failed").toString()
        }
    }

    fun fetchUrlText(rawUrl: String): String {
        val url = if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) rawUrl else "https://$rawUrl"
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")
            .get()
            .build()
        return try {
            http.newCall(req).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                val text = body
                    .replace(Regex("(?is)<script[^>]*>.*?</script>"), " ")
                    .replace(Regex("(?is)<style[^>]*>.*?</style>"), " ")
                    .replace(Regex("<[^>]+>"), " ")
                    .replace(Regex("\\s+"), " ")
                    .trim()
                    .take(5500)
                JSONObject().put("url", url).put("status", resp.code).put("content", text).toString()
            }
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Fetch failed").toString()
        }
    }

    class HttpStatusException(val code: Int, message: String) : Exception(message)
}
