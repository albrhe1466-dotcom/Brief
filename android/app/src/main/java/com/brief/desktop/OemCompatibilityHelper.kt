package com.brief.desktop

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import kotlin.math.sqrt

/**
 * Zero-root OEM compatibility helper for:
 * - Honor Tablets & Phones (Honor Pad 9, MagicPad 2, Pad X9, Pad V9 — MagicOS 8.0 / 9.0+)
 * - Samsung Galaxy Phones & Galaxy Tabs (S26, S25, A54, Tab S10/S9/A9+ — One UI 5–8)
 * - Google Pixel & Pixel Tablet, Xiaomi/Redmi Pad (HyperOS), Oppo/OnePlus Pad (ColorOS),
 *   Vivo Pad (FuntouchOS), Lenovo Tab, LG, Infinix/Tecno, Motorola, and all Android 8–16+.
 */
object OemCompatibilityHelper {

    fun isSamsung(): Boolean {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return m.contains("samsung")
    }

    fun isHonorOrMagicOs(): Boolean {
        val m = "${Build.MANUFACTURER} ${Build.BRAND} ${Build.DISPLAY}".lowercase()
        return m.contains("honor") || m.contains("magic") || m.contains("huawei")
    }

    fun isTablet(context: Context? = null): Boolean {
        val model = (Build.MODEL ?: "").lowercase()
        if (model.contains("pad") || model.contains("tab") || model.contains("hey-") || model.contains("rol-") || model.contains("rod-")) {
            return true
        }
        val ctx = context ?: return false
        val sw = ctx.resources.configuration.smallestScreenWidthDp
        if (sw < 600) return false
        val dm = ctx.resources.displayMetrics
        if (dm.xdpi <= 0f || dm.ydpi <= 0f) return sw >= 720
        val wInches = dm.widthPixels.toDouble() / dm.xdpi.toDouble()
        val hInches = dm.heightPixels.toDouble() / dm.ydpi.toDouble()
        val diag = sqrt(wInches * wInches + hInches * hInches)
        return diag >= 7.0
    }

    fun detectedBrandLabel(context: Context? = null): String {
        val m = (Build.MANUFACTURER ?: "").trim()
        val b = (Build.BRAND ?: "").trim()
        val model = (Build.MODEL ?: "").trim()
        val primary = if (m.isNotEmpty()) m.replaceFirstChar { it.uppercase() } else b.replaceFirstChar { it.uppercase() }
        val form = if (isTablet(context)) "Tablet · " else ""
        return if (model.isNotEmpty() && !model.startsWith(primary, ignoreCase = true)) {
            "$primary $model (${form}Android ${Build.VERSION.RELEASE})"
        } else {
            "$model (${form}Android ${Build.VERSION.RELEASE})"
        }
    }

    fun getZeroRootSetupGuide(context: Context? = null): String {
        val m = "${Build.MANUFACTURER} ${Build.BRAND} ${Build.DISPLAY}".lowercase()
        return when {
            m.contains("honor") || m.contains("magic") || m.contains("huawei") ->
                "Honor Tablet / MagicOS Zero-Root Guide:\n" +
                    "1. Tap '1. Honor MagicOS Keep-Alive' → set Brief to Manual (enable Auto-launch & Run in background so MagicOS keeps the cursor active).\n" +
                    "2. If Accessibility is gray: tap '2. Unlock Gray Switch (⋮)' → top-right ⋮ → 'Allow restricted settings'.\n" +
                    "3. Tap '3. Enable Brief Assistant' → Accessibility features → Accessibility → Installed services → Brief Assistant → ON!"
            m.contains("samsung") ->
                "Samsung Galaxy (S26 to A-Series & Galaxy Tab · One UI) — Fix Gray Switch in 2 Taps:\n" +
                    "1. Tap '1. Samsung Auto Blocker' → turn OFF Auto Blocker in Security & Privacy.\n" +
                    "2. Tap '2. Unlock Gray Switch (⋮)' → tap top-right ⋮ menu → 'Allow restricted settings'.\n" +
                    "3. Tap '3. Enable Brief Assistant' → turn ON Brief Assistant in Installed Apps!"
            m.contains("infinix") || m.contains("tecno") || m.contains("itel") || m.contains("transsion") ->
                "Infinix / Tecno (XOS / HiOS) Zero-Root Guide:\n• Tap '2. Unlock Gray Switch (⋮)' → App Info → ⋮ → Allow restricted settings, then enable Brief Assistant in Accessibility."
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") ->
                "Oppo / Realme / OnePlus (ColorOS / OxygenOS) Zero-Root Guide:\n• Tap '2. Unlock Gray Switch (⋮)' → App Info → ⋮ → Allow restricted settings, then enable Brief Assistant in Accessibility → Downloaded apps."
            m.contains("vivo") || m.contains("iqoo") ->
                "Vivo / iQOO (FuntouchOS / OriginOS) Zero-Root Guide:\n• Tap '2. Unlock Gray Switch (⋮)' → App Info → ⋮ → Allow restricted settings, then enable Brief Assistant in Accessibility."
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") ->
                "Xiaomi / Redmi / POCO (HyperOS / MIUI) Zero-Root Guide:\n• Tap '2. Unlock Gray Switch (⋮)' → App Info → Allow restricted settings, then enable Brief Assistant in Accessibility → Downloaded apps."
            else ->
                "All-Android (${detectedBrandLabel(context)}) Zero-Root Guide:\n• If the Accessibility switch is gray ('Restricted setting'), tap '2. Unlock Gray Switch (⋮)' → top-right ⋮ → Allow restricted settings, then tap '3. Enable Brief Assistant'."
        }
    }

    fun openOemStep1SettingsSafe(context: Context) {
        if (isHonorOrMagicOs()) {
            val pkgUri = Uri.parse("package:${context.packageName}")
            val honorCandidates = listOf(
                Intent().setComponent(ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                Intent().setComponent(ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.optimize.process.ProtectActivity")),
                Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri),
                Intent(Settings.ACTION_SETTINGS)
            )
            launchFirstAvailable(
                context,
                honorCandidates,
                "Honor MagicOS: allow Brief to 'Run in background' so tablet control stays active across apps."
            )
            return
        }
        val candidates = listOf(
            Intent().setComponent(ComponentName("com.samsung.android.sm_cn", "com.samsung.android.sm.security.AutoBlockerActivity")),
            Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.security.AutoBlockerActivity")),
            Intent(Settings.ACTION_SECURITY_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        launchFirstAvailable(
            context,
            candidates,
            "In Security and privacy → tap Auto Blocker → toggle OFF so Samsung unlocks Brief."
        )
    }

    fun openAccessibilitySettingsSafe(context: Context) {
        val candidates = listOf(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        val hint = if (isHonorOrMagicOs()) {
            "Honor MagicOS: tap Accessibility → Installed services → Brief Assistant → Enable."
        } else {
            "Tap Installed apps / Downloaded services → Brief Assistant → Turn ON."
        }
        launchFirstAvailable(context, candidates, hint)
    }

    fun openAppDetailsSafe(context: Context) {
        val pkgUri = Uri.parse("package:${context.packageName}")
        val candidates = listOf(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri),
            Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        launchFirstAvailable(context, candidates, "Tap top-right ⋮ menu → 'Allow restricted settings' to un-gray Brief!")
    }

    private fun launchFirstAvailable(context: Context, intents: List<Intent>, toastHint: String) {
        for (intent in intents) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                Toast.makeText(context, toastHint, Toast.LENGTH_LONG).show()
                return
            } catch (_: Exception) {
                // try next fallback intent for custom OEM ROMs
            }
        }
    }
}
