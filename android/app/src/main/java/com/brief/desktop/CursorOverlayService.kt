package com.brief.desktop

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat

class CursorOverlayService : Service() {
    companion object {
        private const val CHANNEL_ID = "brief_cursor_overlay"
        private const val NOTIF_ID = 4102
        @Volatile
        var instance: CursorOverlayService? = null
            private set

        @Volatile
        var onUserStopRequested: (() -> Unit)? = null

        fun canDrawOverlays(context: Context): Boolean = Settings.canDrawOverlays(context)
    }

    private var wm: WindowManager? = null
    private var overlayView: CursorOverlayView? = null
    private var stopPillView: TextView? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        ensureChannel()
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("Brief Cursor Overlay Active")
            .setContentText("Showing provider cursor over phone apps")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        if (canDrawOverlays(this)) {
            attachViews()
        }
    }

    override fun onDestroy() {
        detachViews()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Brief Floating Cursor", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
    }

    private fun attachViews() {
        if (overlayView != null) return
        val w = getSystemService(WINDOW_SERVICE) as WindowManager
        wm = w

        val view = CursorOverlayView(this)
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        w.addView(view, lp)
        overlayView = view

        val dp = resources.displayMetrics.density
        val pill = TextView(this).apply {
            text = "■ Stop"
            setTextColor(Color.WHITE)
            textSize = 12f
            setPadding((12 * dp).toInt(), (6 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
            background = GradientDrawable().apply {
                setColor(0xE6DC2626.toInt())
                cornerRadius = 999f
            }
            setOnClickListener {
                onUserStopRequested?.invoke()
            }
        }
        val pillLp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = (12 * dp).toInt()
            y = (34 * dp).toInt()
        }
        w.addView(pill, pillLp)
        stopPillView = pill
    }

    private fun detachViews() {
        val w = wm ?: return
        overlayView?.let { try { w.removeView(it) } catch (_: Exception) {} }
        stopPillView?.let { try { w.removeView(it) } catch (_: Exception) {} }
        overlayView = null
        stopPillView = null
    }

    fun updateState(provider: ProviderId, status: String) {
        mainHandler.post { overlayView?.setState(provider, status) }
    }

    fun moveTo(x: Float, y: Float, durationMs: Long = 220L) {
        mainHandler.post { overlayView?.animateMoveTo(x, y, durationMs) }
    }

    fun rippleAt(x: Float, y: Float) {
        mainHandler.post { overlayView?.triggerRipple(x, y) }
    }

    fun setTemporarilyHidden(hidden: Boolean) {
        mainHandler.post {
            val vis = if (hidden) View.INVISIBLE else View.VISIBLE
            overlayView?.visibility = vis
            stopPillView?.visibility = vis
        }
    }
}
