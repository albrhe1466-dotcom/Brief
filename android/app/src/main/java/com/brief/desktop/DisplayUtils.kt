package com.brief.desktop

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager

object DisplayUtils {
    fun getRealScreenSize(context: Context): Pair<Int, Int> {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.maximumWindowMetrics.bounds
            bounds.width() to bounds.height()
        } else {
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            dm.widthPixels to dm.heightPixels
        }
    }

    fun normToPx(norm: Double, maxPx: Int): Float {
        val clamped = norm.coerceIn(0.0, 1000.0)
        return ((clamped / 1000.0) * maxPx).toFloat()
    }
}
