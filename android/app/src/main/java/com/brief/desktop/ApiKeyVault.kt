package com.brief.desktop

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class ApiKeyVault(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("brief_vault_prefs", Context.MODE_PRIVATE)
    private val alias = "BriefMasterAesKey"

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        kg.init(spec)
        return kg.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val enc = cipher.doFinal(plain.toByteArray(StandardCharsets.UTF_8))
        return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String? {
        return try {
            val parts = stored.split(":")
            if (parts.size != 2) return null
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val data = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(data), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun saveKey(provider: ProviderId, apiKey: String) {
        val trimmed = apiKey.trim()
        if (trimmed.isEmpty()) return
        val sealed = encrypt(trimmed)
        prefs.edit()
            .putString("key_${provider.wireId}", sealed)
            .putString("active_provider", provider.wireId)
            .apply()
    }

    fun getKey(provider: ProviderId): String? {
        val enc = prefs.getString("key_${provider.wireId}", null) ?: return null
        return decrypt(enc)
    }

    fun clearKey(provider: ProviderId) {
        prefs.edit().remove("key_${provider.wireId}").apply()
    }

    fun hasKey(provider: ProviderId): Boolean = !getKey(provider).isNullOrBlank()

    fun getActiveProvider(): ProviderId =
        ProviderId.fromWire(prefs.getString("active_provider", "gemini"))

    fun setActiveProvider(provider: ProviderId) {
        prefs.edit().putString("active_provider", provider.wireId).apply()
    }

    fun getActiveModel(provider: ProviderId): String {
        val saved = prefs.getString("model_${provider.wireId}", null)
        return if (saved.isNullOrBlank()) ProviderModels.defaultModelFor(provider) else saved
    }

    fun setActiveModel(provider: ProviderId, modelId: String) {
        prefs.edit().putString("model_${provider.wireId}", modelId).apply()
    }

    fun getThinkingLevel(): ThinkingLevel {
        val raw = prefs.getString("thinking_level", "medium") ?: "medium"
        return ThinkingLevel.entries.firstOrNull { it.wire == raw } ?: ThinkingLevel.MEDIUM
    }

    fun setThinkingLevel(level: ThinkingLevel) {
        prefs.edit().putString("thinking_level", level.wire).apply()
    }
}
