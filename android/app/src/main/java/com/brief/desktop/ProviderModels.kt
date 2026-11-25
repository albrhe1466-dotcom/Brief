package com.brief.desktop

enum class ProviderId(
    val wireId: String,
    val displayName: String,
    val endpointHost: String,
    val accentColorHex: Long
) {
    GEMINI("gemini", "Gemini", "generativelanguage.googleapis.com", 0xFF1A73E8L),
    OPENAI("openai", "OpenAI", "api.openai.com", 0xFF1D6CE0L),
    ANTHROPIC("anthropic", "Claude", "api.anthropic.com", 0xFFD97757L),
    OPENROUTER("openrouter", "OpenRouter", "openrouter.ai", 0xFF6366F1L);

    companion object {
        fun fromWire(raw: String?): ProviderId {
            return when (raw?.trim()?.lowercase()) {
                "openai", "gpt", "codex" -> OPENAI
                "anthropic", "claude" -> ANTHROPIC
                "openrouter" -> OPENROUTER
                else -> GEMINI
            }
        }

        fun detectFromKey(key: String?): ProviderId {
            val k = key?.trim().orEmpty()
            return when {
                k.startsWith("sk-or-", ignoreCase = true) -> OPENROUTER
                k.startsWith("sk-ant-", ignoreCase = true) -> ANTHROPIC
                k.startsWith("sk-", ignoreCase = true) -> OPENAI
                else -> GEMINI
            }
        }
    }
}

enum class ThinkingLevel(val wire: String, val label: String) {
    LOW("low", "Low"),
    MEDIUM("medium", "Medium"),
    HIGH("high", "High"),
    EXTRA("extra", "Extra");

    fun next(): ThinkingLevel {
        val all = entries
        return all[(ordinal + 1) % all.size]
    }
}

data class ModelPreset(
    val id: String,
    val label: String,
    val hint: String,
    val supportsThinking: Boolean = true
)

object ProviderModels {
    fun presetsFor(provider: ProviderId): List<ModelPreset> = when (provider) {
        ProviderId.GEMINI -> listOf(
            ModelPreset("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "Fastest"),
            ModelPreset("gemini-3.8-flash", "Gemini 3.8 Flash", "Balanced"),
            ModelPreset("gemini-4-hydrogen", "Gemini 4 Hydrogen", "Balanced"),
            ModelPreset("gemini-4-neon", "Gemini 4 Neon", "Strong"),
            ModelPreset("gemini-4-argon", "Gemini 4 Argon", "Flagship")
        )
        ProviderId.OPENAI -> listOf(
            ModelPreset("auto", "Auto", "Smart"),
            ModelPreset("gpt-6.1-terra", "GPT-6 Terra", "Balanced")
        )
        ProviderId.ANTHROPIC -> listOf(
            ModelPreset("claude-haiku-5-5", "Claude Haiku 5.5", "Fastest", false),
            ModelPreset("claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced"),
            ModelPreset("claude-opus-5-5", "Claude Opus 5.5", "Strong"),
            ModelPreset("claude-fable-5-2", "Claude Fable 5.2", "Reasoning")
        )
        ProviderId.OPENROUTER -> listOf(
            ModelPreset("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "Fastest"),
            ModelPreset("google/gemini-3.8-flash", "Gemini 3.8 Flash", "Balanced"),
            ModelPreset("google/gemini-4-hydrogen", "Gemini 4 Hydrogen", "Balanced"),
            ModelPreset("google/gemini-4-neon", "Gemini 4 Neon", "Strong"),
            ModelPreset("google/gemini-4-argon", "Gemini 4 Argon", "Flagship"),
            ModelPreset("openai/gpt-6-luna", "GPT-6 Luna", "Fastest"),
            ModelPreset("openai/gpt-6.1-terra", "GPT-6.1 Terra", "Balanced"),
            ModelPreset("openai/gpt-6-sol", "GPT-6 Sol", "Strong"),
            ModelPreset("openai/gpt-6.2-astra", "GPT-6.2 Astra", "Flagship"),
            ModelPreset("anthropic/claude-haiku-5-5", "Claude Haiku 5.5", "Fastest", false),
            ModelPreset("anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced"),
            ModelPreset("anthropic/claude-opus-5-5", "Claude Opus 5.5", "Strong"),
            ModelPreset("anthropic/claude-fable-5-2", "Claude Fable 5.2", "Reasoning")
        )
    }

    fun defaultModelFor(provider: ProviderId): String = when (provider) {
        ProviderId.GEMINI -> "gemini-3.8-flash"
        ProviderId.OPENAI -> "auto"
        ProviderId.ANTHROPIC -> "claude-sonnet-5-5"
        ProviderId.OPENROUTER -> "google/gemini-3.8-flash"
    }

    fun resolveRuntimeCandidates(provider: ProviderId, chosen: String, discovered: List<String> = emptyList()): List<String> {
        val exact = chosen.trim().removePrefix("models/")
        val id = exact.lowercase()
        val out = mutableListOf<String>()
        fun add(cand: String) {
            val clean = cand.trim().removePrefix("models/")
            if (clean.isNotEmpty() && !out.contains(clean)) out.add(clean)
        }
        add(exact)
        when (provider) {
            ProviderId.GEMINI -> {
                when {
                    id.contains("flash-lite") || id.contains("lite") -> {
                        discovered.filter { it.contains("lite", true) }.forEach(::add)
                        add("gemini-3.5-flash-lite")
                        add("gemini-3.1-flash-lite-preview")
                        add("gemini-2.5-flash-lite")
                    }
                    id.contains("neon") || id.contains("argon") || id.contains("pro") -> {
                        discovered.filter { it.contains("pro", true) || it.contains("neon", true) || it.contains("argon", true) }.forEach(::add)
                        add("gemini-4-argon")
                        add("gemini-3.1-pro-preview")
                        add("gemini-2.5-pro")
                    }
                    else -> {
                        discovered.filter { it.contains("flash", true) && !it.contains("lite", true) }.forEach(::add)
                        add("gemini-3.8-flash")
                        add("gemini-3-flash-preview")
                        add("gemini-2.5-flash")
                    }
                }
            }
            ProviderId.OPENAI -> {
                when {
                    id == "auto" || id == "openai_auto" -> {
                        out.remove("auto")
                        out.remove("openai_auto")
                        add("gpt-6.1-terra")
                        add("gpt-5-mini")
                        add("gpt-5")
                        add("gpt-4.1-mini")
                    }
                    id.contains("luna") -> { add("gpt-6-luna"); add("gpt-5-nano"); add("gpt-5-mini"); add("gpt-4o-mini") }
                    id.contains("terra") -> { add("gpt-6.1-terra"); add("gpt-5-mini"); add("gpt-5"); add("gpt-4.1-mini") }
                    id.contains("sol") -> { add("gpt-6-sol"); add("gpt-5"); add("gpt-4.1") }
                    else -> { add("gpt-6.2-astra"); add("gpt-5.2"); add("gpt-5"); add("gpt-4.1") }
                }
            }
            ProviderId.ANTHROPIC -> {
                when {
                    id.contains("haiku") -> { add("claude-haiku-5-5"); add("claude-haiku-4-5"); add("claude-3-5-haiku-latest") }
                    id.contains("opus") || id.contains("fable") -> { add("claude-opus-5-5"); add("claude-opus-4-6"); add("claude-opus-4-5"); add("claude-sonnet-4-6") }
                    else -> { add("claude-sonnet-5-5"); add("claude-sonnet-4-6"); add("claude-sonnet-4-5") }
                }
            }
            ProviderId.OPENROUTER -> {
                when {
                    id.contains("flash-lite") -> { add("google/gemini-3.5-flash-lite"); add("google/gemini-2.5-flash-lite") }
                    id.contains("3.8-flash") -> { add("google/gemini-3.8-flash"); add("google/gemini-2.5-flash") }
                    id.contains("luna") -> { add("openai/gpt-6-luna"); add("openai/gpt-5-nano"); add("openai/gpt-4o-mini") }
                    id.contains("terra") -> { add("openai/gpt-6.1-terra"); add("openai/gpt-5-mini"); add("openai/gpt-4.1-mini") }
                    id.contains("haiku") -> { add("anthropic/claude-haiku-5-5"); add("anthropic/claude-haiku-4.5") }
                    id.contains("sonnet") -> { add("anthropic/claude-sonnet-5-5"); add("anthropic/claude-sonnet-4.6"); add("anthropic/claude-sonnet-4.5") }
                    else -> add(defaultModelFor(ProviderId.OPENROUTER))
                }
            }
        }
        return out
    }
}
