package com.brief.desktop

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

/**
 * Zero-root OEM compatibility helper for Samsung (One UI), Google Pixel, LG,
 * Infinix (XOS), Tecno/Itel (HiOS), Oppo/Realme/OnePlus (ColorOS/OxygenOS),
 * Vivo/iQOO (FuntouchOS/OriginOS), Xiaomi/Redmi/POCO (HyperOS/MIUI), Motorola,
 * Honor/Huawei, Sony, Asus, Nothing, and all Android 8.0 - 15+ devices.
 */
object OemCompatibilityHelper {

    fun detectedBrandLabel(): String {
        val m = (Build.MANUFACTURER ?: "").trim()
        val b = (Build.BRAND ?: "").trim()
        val model = (Build.MODEL ?: "").trim()
        val primary = if (m.isNotEmpty()) m.replaceFirstChar { it.uppercase() } else b.replaceFirstChar { it.uppercase() }
        return if (model.isNotEmpty() && !model.startsWith(primary, ignoreCase = true)) {
            "$primary $model (Android ${Build.VERSION.RELEASE})"
        } else {
            "$model (Android ${Build.VERSION.RELEASE})"
        }
    }

    fun getZeroRootSetupGuide(): String {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        val restrictedNote = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            "If Android 13–15 shows 'Restricted setting' on Accessibility: tap this box to open Brief App Info → tap top-right ⋮ menu → Allow restricted settings (zero root needed)."
        } else {
            "Tap this box anytime to open Brief App Info & permissions."
        }
        return when {
            m.contains("samsung") ->
                "Samsung Galaxy (One UI) Zero-Root Guide:\n• Enable 'Appear on top' (Floating Cursor) and 'Installed apps → Brief' in Accessibility.\n• $restrictedNote"
            m.contains("infinix") || m.contains("tecno") || m.contains("itel") || m.contains("transsion") ->
                "Infinix / Tecno (XOS / HiOS) Zero-Root Guide:\n• Enable 'Display over other apps' & Accessibility → Downloaded/Installed Services → Brief.\n• Turn on Auto-start in Phone Master / App Management so the cursor stays active.\n• $restrictedNote"
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") ->
                "Oppo / Realme / OnePlus (ColorOS / OxygenOS) Zero-Root Guide:\n• Enable 'Floating Window / Display over other apps' and Accessibility → Downloaded apps → Brief.\n• $restrictedNote"
            m.contains("vivo") || m.contains("iqoo") ->
                "Vivo / iQOO (FuntouchOS / OriginOS) Zero-Root Guide:\n• Allow 'Floating window' & 'Background pop-ups' in App Info, then enable Brief in Accessibility.\n• $restrictedNote"
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") ->
                "Xiaomi / Redmi / POCO (HyperOS / MIUI) Zero-Root Guide:\n• Allow 'Display pop-up windows while running in background' under Other Permissions, then enable Brief in Accessibility → Downloaded apps.\n• $restrictedNote"
            m.contains("lge") || m.contains("lg") ->
                "LG Android Zero-Root Guide:\n• Enable 'Draw over other apps' and turn on Brief under Settings → Accessibility → Services.\n• $restrictedNote"
            m.contains("google") || m.contains("pixel") ->
                "Google Pixel Zero-Root Guide:\n• Enable 'Display over other apps' and Accessibility → Downloaded apps → Brief.\n• $restrictedNote"
            else ->
                "All-Android (${detectedBrandLabel()}) Zero-Root Guide:\n• Enable Floating Cursor Overlay + Brief Accessibility Service.\n• $restrictedNote"
        }
    }

    fun openOverlaySettingsSafe(context: Context) {
        val pkgUri = Uri.parse("package:${context.packageName}")
        val candidates = listOf(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkgUri),
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri),
            Intent(Settings.ACTION_SETTINGS)
        )
        launchFirstAvailable(context, candidates, "Open 'Appear on top / Display over other apps' for Brief.")
    }

    fun openAccessibilitySettingsSafe(context: Context) {
        val candidates = listOf(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        launchFirstAvailable(context, candidates, "Enable Brief under Installed / Downloaded Accessibility services.")
    }

    fun openAppDetailsSafe(context: Context) {
        val pkgUri = Uri.parse("package:${context.packageName}")
        val candidates = listOf(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri),
            Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        launchFirstAvailable(context, candidates, "In App Info, tap top-right ⋮ → Allow restricted settings (if shown).")
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
