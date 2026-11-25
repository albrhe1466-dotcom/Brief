package com.brief.desktop

import android.content.Context
import android.hardware.display.DisplayManager
import android.util.DisplayMetrics
import android.view.Display

/**
 * Safe full-screen pixel metrics for both Activity and AccessibilityService contexts
 * across Android 8–16, Samsung One UI, and Honor MagicOS 8/9 Tablets (Portrait & Landscape).
 * Uses DisplayManager instead of WindowManager.maximumWindowMetrics so non-visual Service
 * contexts never throw IllegalArgumentException on Android 12–16!
 */
object DisplayUtils {
    fun getRealScreenSize(context: Context): Pair<Int, Int> {
        val dm = DisplayMetrics()
        val displayManager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val display = displayManager?.getDisplay(Display.DEFAULT_DISPLAY)
        if (display != null) {
            @Suppress("DEPRECATION")
            display.getRealMetrics(dm)
            if (dm.widthPixels > 0 && dm.heightPixels > 0) {
                return dm.widthPixels to dm.heightPixels
            }
        }
        val resDm = context.resources.displayMetrics
        return resDm.widthPixels.coerceAtLeast(360) to resDm.heightPixels.coerceAtLeast(640)
    }

    fun normToPx(norm: Double, maxPx: Int): Float {
        val clamped = norm.coerceIn(0.0, 1000.0)
        return ((clamped / 1000.0) * maxPx).toFloat()
    }
}
