package com.brief.desktop

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

/**
 * Zero-root OEM compatibility helper for Samsung Galaxy (S26, S25, S24, S23, Z Fold/Flip,
 * and A-series cheap-to-flagship One UI 5–8), Google Pixel, LG, Infinix (XOS),
 * Tecno/Itel (HiOS), Oppo/Realme/OnePlus (ColorOS/OxygenOS), Vivo/iQOO (FuntouchOS),
 * Xiaomi/Redmi/POCO (HyperOS/MIUI), Motorola, and all Android 8.0–16+ devices.
 */
object OemCompatibilityHelper {

    fun isSamsung(): Boolean {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return m.contains("samsung")
    }

    fun isTablet(context: Context? = null): Boolean {
        val ctx = context ?: return false
        val sw = ctx.resources.configuration.smallestScreenWidthDp
        if (sw < 600) return false
        val dm = ctx.resources.displayMetrics
        if (dm.xdpi <= 0f || dm.ydpi <= 0f) return sw >= 720
        val wInches = dm.widthPixels.toDouble() / dm.xdpi.toDouble()
        val hInches = dm.heightPixels.toDouble() / dm.ydpi.toDouble()
        val diag = kotlin.math.sqrt(wInches * wInches + hInches * hInches)
        return diag >= 7.2
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

    fun getZeroRootSetupGuide(): String {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return when {
            m.contains("samsung") ->
                "Samsung Galaxy (S26 to A-Series · One UI) — Fix Gray Switch in 2 Taps:\n" +
                    "1. Tap '1. Samsung Auto Blocker' → turn OFF Auto Blocker (stops Samsung blocking sideloaded apps & graying out switches).\n" +
                    "2. Tap '2. Unlock Gray Switch (⋮)' → tap top-right ⋮ menu → 'Allow restricted settings'.\n" +
                    "3. Tap '3. Enable Brief Assistant' → turn ON Brief in Installed Apps (enables both Floating Cursors + Touch Control in 1 switch!)."
            m.contains("infinix") || m.contains("tecno") || m.contains("itel") || m.contains("transsion") ->
                "Infinix / Tecno (XOS / HiOS) Zero-Root Guide:\n• Tap 'Unlock Gray Switch (⋮)' → App Info → ⋮ → Allow restricted settings, then enable Brief in Accessibility."
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") ->
                "Oppo / Realme / OnePlus (ColorOS / OxygenOS) Zero-Root Guide:\n• Tap 'Unlock Gray Switch (⋮)' → App Info → ⋮ → Allow restricted settings, then enable Brief in Accessibility → Downloaded apps."
            m.contains("vivo") || m.contains("iqoo") ->
                "Vivo / iQOO (FuntouchOS / OriginOS) Zero-Root Guide:\n• Tap 'Unlock Gray Switch (⋮)' → App Info → ⋮ → Allow restricted settings, then enable Brief in Accessibility."
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") ->
                "Xiaomi / Redmi / POCO (HyperOS / MIUI) Zero-Root Guide:\n• Tap 'Unlock Gray Switch (⋮)' → App Info → Allow restricted settings, then enable Brief in Accessibility → Downloaded apps."
            else ->
                "All-Android (${detectedBrandLabel()}) Zero-Root Guide:\n• If the Accessibility switch is gray ('Restricted setting'), tap '2. Unlock Gray Switch (⋮)' → top-right ⋮ → Allow restricted settings, then tap '3. Enable Brief Assistant'."
        }
    }

    fun openSamsungAutoBlockerSettingsSafe(context: Context) {
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
        launchFirstAvailable(context, candidates, "Tap Installed apps → Brief Assistant → Turn ON.")
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
