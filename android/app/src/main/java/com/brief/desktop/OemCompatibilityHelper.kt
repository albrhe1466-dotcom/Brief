package com.brief.desktop

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import kotlin.math.sqrt

/**
 * Zero-root OEM & All-Android permissions + restricted-settings unlocker for:
 * - Honor Tablets & Phones (Honor Pad 9, MagicPad 2, Pad X9, Pad V9 — MagicOS 8.0 / 9.0+)
 * - Samsung Galaxy Phones & Galaxy Tabs (S26, S25, A54, A15, A05, Tab S10/S9/A9+ — One UI 5–8)
 * - Google Pixel, Xiaomi/Redmi/POCO (HyperOS/MIUI), Oppo/Realme/OnePlus (ColorOS),
 *   Vivo/iQOO (FuntouchOS), Lenovo Tab, Infinix/Tecno/itel, Motorola, Nokia, and all Android 8–16+.
 */
object OemCompatibilityHelper {

    fun isArabicLocale(): Boolean {
        return Locale.getDefault().language.equals("ar", ignoreCase = true)
    }

    fun isSamsung(): Boolean {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return m.contains("samsung")
    }

    fun isHonorOrMagicOs(): Boolean {
        val m = "${Build.MANUFACTURER} ${Build.BRAND} ${Build.DISPLAY}".lowercase()
        return m.contains("honor") || m.contains("magic") || m.contains("huawei")
    }

    fun isXiaomiOrHyperOs(): Boolean {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")
    }

    fun needsAndroid13RestrictedUnlock(): Boolean {
        return Build.VERSION.SDK_INT >= 33
    }

    fun hasNotificationPermission(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= 33) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return runCatching { pm.isIgnoringBatteryOptimizations(context.packageName) }.getOrDefault(false)
    }

    fun hasCoreAppPermissions(context: Context): Boolean {
        return hasNotificationPermission(context) && isIgnoringBatteryOptimizations(context)
    }

    fun requestNativeControlPermissions(activity: Activity) {
        if (Build.VERSION.SDK_INT >= 33 && !hasNotificationPermission(activity)) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
        if (!isIgnoringBatteryOptimizations(activity)) {
            try {
                val intent = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${activity.packageName}")
                )
                activity.startActivity(intent)
                return
            } catch (_: Exception) {
                try {
                    activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    return
                } catch (_: Exception) {}
            }
        }
        if (isHonorOrMagicOs()) {
            openOemStep1SettingsSafe(activity)
        } else {
            val msg = if (isArabicLocale()) {
                "تم منح أذونات التطبيق والخلفية بنجاح ✓ انتقل للخطوة التالية!"
            } else {
                "App & background permissions granted ✓ Proceed to the next step!"
            }
            Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
        }
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
        if (isArabicLocale()) {
            return buildString {
                append("طريقة فك الزر الرمادي (تم منع التطبيق من الوصول) لأجهزة Honor و Samsung وكل أندرويد:\n")
                if (isSamsung()) {
                    append("• سامسونج فقط: أوقف (الحظر التلقائي / Auto Blocker) من الحماية والخصوصية أولاً.\n")
                }
                append("1. اضغط (١. منح أذونات التطبيق) للموافقة على الإشعارات والعمل بالخلفية.\n")
                append("2. اضغط (٢. اضغط الزر الرمادي مرة واحدة) ← اختر Brief Assistant واضغط الزر الرمادي حتى تظهر رسالة (تم منع التطبيق من الوصول) ثم اضغط (إغلاق) وارجع هنا.\n")
                append("3. اضغط (٣. فك القفل من قائمة التطبيقات ⋮) ← اختر Brief من القائمة ← اضغط النقاط الثلاث (⋮) في أعلى اليسار (أو اليمين) ← اختر (السماح بالإعدادات المقيدة / المحظورة).\n")
                append("4. اضغط (٤. تفعيل تحكم Brief) ← الآن الزر لم يعد رمادياً! فعّل Brief Assistant للتحكم الكامل.")
            }
        }
        return buildString {
            append("Guaranteed Fix for Gray Switch ('App was denied access') on Honor, Samsung & All Android:\n")
            if (isSamsung()) {
                append("• Samsung Only: Turn OFF 'Auto Blocker' in Security & Privacy first.\n")
            }
            append("1. Tap '1. Grant App Permissions' → Allow Notifications & Background Run.\n")
            append("2. Tap '2. Trigger Gray Switch Once' → tap Brief Assistant → tap the gray switch ONCE so 'App was denied access / Restricted setting' pops up → tap Close and come back! (Android hides ⋮ until you do this once!).\n")
            append("3. Tap '3. Unlock in Apps List (⋮)' → tap 'Brief' in the Apps list → tap top corner ⋮ (top-left in Arabic, top-right in English, or bottom on Xiaomi) → tap 'Allow restricted settings'!\n")
            append("4. Tap '4. Turn ON Brief Control' → switch is now UN-GRAYED! Toggle ON.")
        }
    }

    fun openOemStep1SettingsSafe(context: Context) {
        if (isHonorOrMagicOs()) {
            val honorCandidates = listOf(
                Intent().setComponent(ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                Intent().setComponent(ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.optimize.process.ProtectActivity")),
                Intent().setComponent(ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                Intent(Settings.ACTION_SETTINGS)
            )
            val hint = if (isArabicLocale()) {
                "Honor MagicOS: اسمح لتطبيق Brief بالعمل في الخلفية."
            } else {
                "Honor MagicOS: allow Brief to 'Run in background' so control stays active."
            }
            launchFirstAvailable(context, honorCandidates, hint)
            return
        }
        val candidates = listOf(
            Intent().setComponent(ComponentName("com.samsung.android.sm_cn", "com.samsung.android.sm.security.AutoBlockerActivity")),
            Intent().setComponent(ComponentName("com.samsung.android.lool", "com.samsung.android.sm.security.AutoBlockerActivity")),
            Intent(Settings.ACTION_SECURITY_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        val hint = if (isArabicLocale()) {
            "سامسونج: افتح الحماية والخصوصية ← الحظر التلقائي (Auto Blocker) ← إيقاف."
        } else {
            "Samsung: tap Auto Blocker in Security & Privacy → toggle OFF."
        }
        launchFirstAvailable(context, candidates, hint)
    }

    fun openAccessibilityTriggerStep(context: Context) {
        val candidates = listOf(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        val hint = if (isArabicLocale()) {
            "اضغط Brief Assistant ثم اضغط الزر الرمادي مرة واحدة حتى تظهر (تم منع التطبيق من الوصول) ثم اضغط إغلاق وارجع للتطبيق!"
        } else {
            "Tap Brief Assistant → tap the gray switch ONCE until 'App was denied access' appears → tap Close and come back!"
        }
        launchFirstAvailable(context, candidates, hint)
    }

    fun openAccessibilitySettingsSafe(context: Context) {
        val candidates = listOf(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        val hint = if (isArabicLocale()) {
            "اختر الخدمات المثبتة / التطبيقات المثبتة ← Brief Assistant ← تفعيل (ON)!"
        } else if (isHonorOrMagicOs()) {
            "Honor MagicOS: tap Accessibility → Installed services → Brief Assistant → Turn ON!"
        } else {
            "Tap Installed apps / Downloaded services → Brief Assistant → Turn ON!"
        }
        launchFirstAvailable(context, candidates, hint)
    }

    /**
     * CRITICAL ANDROID 13–16 FIX:
     * Never launch `ACTION_APPLICATION_DETAILS_SETTINGS` directly with our own `package:` URI when
     * unlocking Restricted Settings! Android 13–16 `AppInfoDashboardFragment` intentionally hides
     * the `⋮ -> Allow restricted settings` overflow menu when App Info is deep-linked by an external app.
     * Opening the system Apps list (`ACTION_APPLICATION_SETTINGS` / `ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS`)
     * so the user taps "Brief" inside Settings guarantees `com.android.settings` is the caller and
     * reveals `⋮ -> Allow restricted settings` (السماح بالإعدادات المقيدة) on Honor, Samsung, and all Androids!
     */
    fun openAppsListForRestrictedUnlock(context: Context) {
        val candidates = listOf(
            Intent(Settings.ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS),
            Intent(Settings.ACTION_APPLICATION_SETTINGS),
            Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS),
            Intent(Settings.ACTION_SETTINGS)
        )
        val hint = if (isArabicLocale()) {
            "ابحث واضغط على Brief ← اضغط النقاط الثلاث (⋮) أعلى اليسار ← اختر (السماح بالإعدادات المقيدة)!"
        } else if (isXiaomiOrHyperOs()) {
            "Tap 'Brief' in Apps list → scroll to bottom (or top ⋮) → tap 'Allow restricted settings'!"
        } else {
            "Tap 'Brief' in Apps list → tap top ⋮ (3 dots) → tap 'Allow restricted settings'!"
        }
        launchFirstAvailable(context, candidates, hint)
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
