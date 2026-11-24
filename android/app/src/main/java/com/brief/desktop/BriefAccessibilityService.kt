package com.brief.desktop

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

/**
 * Unified Zero-Root Phone Control + Trusted Accessibility Cursor Overlay + On-Demand Vision.
 *
 * Uses Android's official `WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY` and
 * `AccessibilityService.takeScreenshot` (Android 11+ / One UI 3–8 including Galaxy S26),
 * completely eliminating `SYSTEM_ALERT_WINDOW`, `MediaProjection`, and background FGS
 * permissions so Google Play Protect & Samsung Device Protection recognize Brief as safe!
 */
class BriefAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: BriefAccessibilityService? = null
            private set

        @Volatile
        var onUserStopRequested: (() -> Unit)? = null

        fun isEnabled(context: Context): Boolean {
            if (instance != null) return true
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            val target = ComponentName(context, BriefAccessibilityService::class.java).flattenToString()
            return enabled.split(":").any { it.equals(target, ignoreCase = true) }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var wm: WindowManager? = null
    private var overlayView: CursorOverlayView? = null
    private var stopPillView: TextView? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {}

    override fun onInterrupt() {
        hideOverlay()
    }

    override fun onDestroy() {
        hideOverlay()
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun showOverlay(provider: ProviderId, status: String) {
        mainHandler.post {
            try {
                if (overlayView == null) {
                    val w = getSystemService(WINDOW_SERVICE) as WindowManager
                    wm = w

                    val view = CursorOverlayView(this)
                    val lp = WindowManager.LayoutParams(
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                        PixelFormat.TRANSLUCENT
                    ).apply {
                        gravity = Gravity.TOP or Gravity.START
                    }
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
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                        PixelFormat.TRANSLUCENT
                    ).apply {
                        gravity = Gravity.TOP or Gravity.END
                        x = (12 * dp).toInt()
                        y = (36 * dp).toInt()
                    }
                    w.addView(pill, pillLp)
                    stopPillView = pill
                }
                overlayView?.visibility = View.VISIBLE
                stopPillView?.visibility = View.VISIBLE
                overlayView?.setState(provider, status)
            } catch (_: Exception) {
                // Ignore if window token is momentarily transitioning
            }
        }
    }

    fun updateOverlayState(provider: ProviderId, status: String) {
        mainHandler.post {
            overlayView?.setState(provider, status)
        }
    }

    fun hideOverlay() {
        mainHandler.post {
            val w = wm
            if (w != null) {
                overlayView?.let { runCatching { w.removeView(it) } }
                stopPillView?.let { runCatching { w.removeView(it) } }
            }
            overlayView = null
            stopPillView = null
        }
    }

    private fun setOverlayHiddenTemporarily(hidden: Boolean) {
        mainHandler.post {
            val vis = if (hidden) View.INVISIBLE else View.VISIBLE
            overlayView?.visibility = vis
            stopPillView?.visibility = vis
        }
    }

    suspend fun captureScreenshotJpegBase64(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        setOverlayHiddenTemporarily(true)
        delay(45L)
        val encoded = suspendCancellableCoroutine<String?> { cont ->
            try {
                takeScreenshot(
                    Display.DEFAULT_DISPLAY,
                    mainExecutor,
                    object : TakeScreenshotCallback {
                        override fun onSuccess(screenshot: ScreenshotResult) {
                            try {
                                val hwBuf = screenshot.hardwareBuffer
                                val hwBmp = Bitmap.wrapHardwareBuffer(hwBuf, screenshot.colorSpace)
                                val swBmp = hwBmp?.copy(Bitmap.Config.ARGB_8888, false)
                                hwBmp?.recycle()
                                hwBuf.close()
                                if (swBmp == null) {
                                    if (cont.isActive) cont.resume(null)
                                    return
                                }
                                val scaled = if (swBmp.width > 900) {
                                    val targetW = 900
                                    val targetH = ((swBmp.height.toFloat() / swBmp.width.toFloat()) * targetW).toInt().coerceAtLeast(1)
                                    Bitmap.createScaledBitmap(swBmp, targetW, targetH, true).also {
                                        if (it !== swBmp) swBmp.recycle()
                                    }
                                } else {
                                    swBmp
                                }
                                val out = ByteArrayOutputStream()
                                scaled.compress(Bitmap.CompressFormat.JPEG, 76, out)
                                scaled.recycle()
                                val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                                if (cont.isActive) cont.resume(b64)
                            } catch (_: Exception) {
                                if (cont.isActive) cont.resume(null)
                            }
                        }

                        override fun onFailure(errorCode: Int) {
                            if (cont.isActive) cont.resume(null)
                        }
                    }
                )
            } catch (_: Exception) {
                if (cont.isActive) cont.resume(null)
            }
        }
        setOverlayHiddenTemporarily(false)
        return encoded
    }

    private suspend fun dispatchPath(path: Path, durationMs: Long): Boolean {
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceAtLeast(30L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return suspendCancellableCoroutine { cont ->
            val ok = dispatchGesture(gesture, object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    if (cont.isActive) cont.resume(true)
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    if (cont.isActive) cont.resume(false)
                }
            }, null)
            if (!ok && cont.isActive) cont.resume(false)
        }
    }

    suspend fun tapNormalized(nx: Double, ny: Double, longPress: Boolean = false): Boolean {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val px = DisplayUtils.normToPx(nx, w).coerceIn(4f, (w - 4).toFloat())
        val py = DisplayUtils.normToPx(ny, h).coerceIn(4f, (h - 4).toFloat())

        mainHandler.post { overlayView?.animateMoveTo(px, py, 200L) }
        delay(190L)
        mainHandler.post { overlayView?.triggerRipple(px, py) }

        val p = Path().apply { moveTo(px, py) }
        return dispatchPath(p, if (longPress) 700L else 55L)
    }

    suspend fun doubleTapNormalized(nx: Double, ny: Double): Boolean {
        val ok1 = tapNormalized(nx, ny, false)
        delay(85L)
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val px = DisplayUtils.normToPx(nx, w).coerceIn(4f, (w - 4).toFloat())
        val py = DisplayUtils.normToPx(ny, h).coerceIn(4f, (h - 4).toFloat())
        mainHandler.post { overlayView?.triggerRipple(px, py) }
        val ok2 = dispatchPath(Path().apply { moveTo(px, py) }, 50L)
        return ok1 && ok2
    }

    suspend fun swipeNormalized(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Long = 340L): Boolean {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val sx = DisplayUtils.normToPx(x1, w).coerceIn(6f, (w - 6).toFloat())
        val sy = DisplayUtils.normToPx(y1, h).coerceIn(6f, (h - 6).toFloat())
        val ex = DisplayUtils.normToPx(x2, w).coerceIn(6f, (w - 6).toFloat())
        val ey = DisplayUtils.normToPx(y2, h).coerceIn(6f, (h - 6).toFloat())

        mainHandler.post { overlayView?.animateMoveTo(sx, sy, 150L) }
        delay(140L)
        mainHandler.post { overlayView?.animateMoveTo(ex, ey, durationMs.coerceIn(140L, 900L)) }

        val p = Path().apply {
            moveTo(sx, sy)
            lineTo(ex, ey)
        }
        return dispatchPath(p, durationMs.coerceIn(140L, 900L))
    }

    fun typeTextIntoFocused(text: String, submit: Boolean = false): Pair<Boolean, String> {
        val root = rootInActiveWindow ?: return false to "No active window visible."
        val target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: findFirstEditable(root, 0)
            ?: return false to "No text box found on screen. Tap an input box first."

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val setOk = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (setOk && submit) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            }
        }
        return setOk to (if (setOk) "Typed text cleanly." else "Input field rejected SET_TEXT.")
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
        if (node == null || depth > 22) return null
        if (node.isEditable && node.isVisibleToUser) return node
        for (i in 0 until node.childCount) {
            val hit = findFirstEditable(node.getChild(i), depth + 1)
            if (hit != null) return hit
        }
        return null
    }

    fun readScreenElements(): JSONObject {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val root = rootInActiveWindow
        val items = JSONArray()
        val pkg = root?.packageName?.toString().orEmpty()
        if (root != null) {
            collectNodes(root, w.coerceAtLeast(1), h.coerceAtLeast(1), items, 0)
        }
        return JSONObject().apply {
            put("packageName", pkg)
            put("screenWidth", w)
            put("screenHeight", h)
            put("elements", items)
        }
    }

    private fun collectNodes(
        node: AccessibilityNodeInfo?,
        w: Int,
        h: Int,
        out: JSONArray,
        depth: Int
    ) {
        if (node == null || depth > 24 || out.length() >= 65) return
        if (node.isVisibleToUser) {
            val txt = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            val label = when {
                txt.isNotEmpty() && desc.isNotEmpty() && txt != desc -> "$txt ($desc)"
                txt.isNotEmpty() -> txt
                else -> desc
            }
            if (label.isNotEmpty() || node.isEditable || node.isClickable) {
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if (rect.width() > 4 && rect.height() > 4) {
                    val cx = ((rect.exactCenterX() / w.toFloat()) * 1000.0).toInt().coerceIn(0, 1000)
                    val cy = ((rect.exactCenterY() / h.toFloat()) * 1000.0).toInt().coerceIn(0, 1000)
                    if (label.isNotEmpty() || node.isEditable) {
                        out.put(JSONObject().apply {
                            put("label", label.take(80))
                            put("x", cx)
                            put("y", cy)
                            if (node.isClickable) put("clickable", true)
                            if (node.isEditable) put("editable", true)
                            if (node.isFocused) put("focused", true)
                        })
                    }
                }
            }
        }
        for (i in 0 until node.childCount) {
            if (out.length() >= 65) break
            collectNodes(node.getChild(i), w, h, out, depth + 1)
        }
    }

    fun launchAppByName(query: String): Pair<Boolean, String> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return false to "App name is empty."
        val pm = packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = pm.queryIntentActivities(mainIntent, 0)
        val best = resolved.firstOrNull { ri ->
            val label = ri.loadLabel(pm)?.toString()?.lowercase().orEmpty()
            label == q
        } ?: resolved.firstOrNull { ri ->
            val label = ri.loadLabel(pm)?.toString()?.lowercase().orEmpty()
            val pkg = ri.activityInfo?.packageName?.lowercase().orEmpty()
            label.contains(q) || pkg.contains(q)
        } ?: return false to "Could not find an installed app matching \"$query\"."

        val pkgName = best.activityInfo.packageName
        val launch = pm.getLaunchIntentForPackage(pkgName)
            ?: return false to "App $pkgName cannot be launched directly."
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        startActivity(launch)
        val appTitle = best.loadLabel(pm)?.toString() ?: pkgName
        return true to "Opened $appTitle ($pkgName)"
    }

    fun openWebUrl(rawUrl: String): Pair<Boolean, String> {
        val url = if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) rawUrl else "https://$rawUrl"
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            true to "Opened $url in default phone browser."
        } catch (e: Exception) {
            false to "Could not open URL: ${e.message}"
        }
    }
}
