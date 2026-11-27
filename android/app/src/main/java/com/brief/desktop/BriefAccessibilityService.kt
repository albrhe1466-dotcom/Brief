package com.brief.desktop

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.TextView
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlin.math.abs

data class VisionFrame(
    val cleanUserBase64: String,
    val calibratedAiBase64: String,
    val width: Int,
    val height: Int,
    val sampledFrames: Int
)

/**
 * Unified Zero-Root Phone & Tablet Control + PC-Style Animated Cursor + 150-Frame Live Vision.
 *
 * Key guarantees:
 * 1. NEVER clicks its own `■ Stop` button: `stopPillView` is placed safely at bottom-left
 *    (away from top-right app Search/Menu bars), becomes `FLAG_NOT_TOUCHABLE` whenever Brief
 *    is injecting ANY gesture, and ignores any touch within 450ms of an AI gesture.
 * 2. Keeps the animated provider cursor smoothly visible like a PC mouse with custom speed
 *    glide + target check reticle + click bounce.
 * 3. 150-Frame Live Vision: samples live screen stability up to 150 rapid ticks so splash
 *    screens and animations settle before capturing crisp calibrated HD screenshots + 150 UI nodes.
 */
class BriefAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: BriefAccessibilityService? = null
            private set

        @Volatile
        var onUserStopRequested: (() -> Unit)? = null

        @Volatile
        var configuredCursorSpeedMs: Long = 560L

        @Volatile
        var configuredTouchTypingMode: String = "touch"

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
    private var stopPillLp: WindowManager.LayoutParams? = null

    @Volatile
    private var agentGestureActive: Boolean = false

    @Volatile
    private var lastAgentGestureEndUptimeMs: Long = 0L

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

    @SuppressLint("ClickableViewAccessibility")
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
                    val isTab = OemCompatibilityHelper.isTablet(this)
                    val pillLp = WindowManager.LayoutParams(
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                        PixelFormat.TRANSLUCENT
                    ).apply {
                        // Safe bottom-left dock (away from top-right Search icons & center feeds!)
                        gravity = Gravity.BOTTOM or Gravity.START
                        x = (10 * dp).toInt()
                        y = (if (isTab) 84 * dp else 96 * dp).toInt()
                    }
                    stopPillLp = pillLp

                    var downRawX = 0f
                    var downRawY = 0f
                    var startLpX = 0
                    var startLpY = 0
                    var dragged = false

                    val pill = TextView(this).apply {
                        text = "■ Stop"
                        setTextColor(Color.WHITE)
                        textSize = if (isTab) 11.5f else 10.5f
                        setPadding((10 * dp).toInt(), (5 * dp).toInt(), (10 * dp).toInt(), (5 * dp).toInt())
                        background = GradientDrawable().apply {
                            setColor(0xD8DC2626.toInt())
                            cornerRadius = 999f
                            setStroke((1 * dp).toInt(), 0x88FCA5A5.toInt())
                        }
                        setOnTouchListener { v, ev ->
                            // NEVER allow an AI-injected gesture to trigger Stop!
                            if (agentGestureActive || (SystemClock.uptimeMillis() - lastAgentGestureEndUptimeMs) < 450L) {
                                return@setOnTouchListener true
                            }
                            when (ev.actionMasked) {
                                MotionEvent.ACTION_DOWN -> {
                                    downRawX = ev.rawX
                                    downRawY = ev.rawY
                                    startLpX = pillLp.x
                                    startLpY = pillLp.y
                                    dragged = false
                                    true
                                }
                                MotionEvent.ACTION_MOVE -> {
                                    val dx = ev.rawX - downRawX
                                    val dy = ev.rawY - downRawY
                                    if (abs(dx) > 8 * dp || abs(dy) > 8 * dp) {
                                        dragged = true
                                        pillLp.x = (startLpX + dx.toInt()).coerceAtLeast(4)
                                        pillLp.y = (startLpY - dy.toInt()).coerceAtLeast(24)
                                        runCatching { w.updateViewLayout(v, pillLp) }
                                    }
                                    true
                                }
                                MotionEvent.ACTION_UP -> {
                                    if (!dragged && !agentGestureActive && (SystemClock.uptimeMillis() - lastAgentGestureEndUptimeMs) >= 450L) {
                                        onUserStopRequested?.invoke()
                                    }
                                    true
                                }
                                else -> false
                            }
                        }
                    }
                    w.addView(pill, pillLp)
                    stopPillView = pill
                }
                overlayView?.visibility = View.VISIBLE
                stopPillView?.visibility = View.VISIBLE
                overlayView?.setState(provider, status)
            } catch (_: Exception) {
                // Ignore transient window transitions
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
            stopPillLp = null
        }
    }

    private fun setStopPillPassThrough(passThrough: Boolean) {
        mainHandler.post {
            val w = wm ?: return@post
            val pill = stopPillView ?: return@post
            val lp = stopPillLp ?: return@post
            val baseFlags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
            lp.flags = if (passThrough) {
                baseFlags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            } else {
                baseFlags
            }
            pill.alpha = if (passThrough) 0.45f else 1.0f
            runCatching { w.updateViewLayout(pill, lp) }
        }
    }

    /**
     * 150-Frame Live Vision Stability Sampler:
     * Samples the foreground UI tree across up to 150 rapid sub-frame intervals (`maxWaitMs`)
     * until the app finishes transitioning/rendering (e.g. YouTube splash -> home feed -> search results).
     */
    suspend fun awaitScreenSettle150Frames(maxWaitMs: Long = 950L, expectAwayFromBrief: Boolean = false): Int {
        val start = SystemClock.uptimeMillis()
        var lastSig = ""
        var stableFrames = 0
        var sampled = 0
        while (sampled < 150 && (SystemClock.uptimeMillis() - start) < maxWaitMs) {
            sampled++
            val root = activeAppRoot()
            val pkg = root?.packageName?.toString().orEmpty()
            if (expectAwayFromBrief && (pkg.isEmpty() || pkg == packageName)) {
                stableFrames = 0
                delay(18L)
                continue
            }
            val sig = quickTreeSignature(root)
            if (sig.isNotEmpty() && sig == lastSig) {
                stableFrames++
                if (stableFrames >= 10 && sampled >= 14) break
            } else {
                lastSig = sig
                stableFrames = 0
            }
            delay(8L)
        }
        return sampled
    }

    private fun quickTreeSignature(root: AccessibilityNodeInfo?): String {
        if (root == null) return ""
        val sb = StringBuilder(root.packageName?.toString().orEmpty())
        sb.append('#').append(root.childCount)
        val r = Rect()
        val limit = root.childCount.coerceAtMost(6)
        for (i in 0 until limit) {
            val c = root.getChild(i) ?: continue
            c.getBoundsInScreen(r)
            sb.append('|').append(r.left).append(',').append(r.top).append(',').append(c.childCount)
        }
        return sb.toString()
    }

    /**
     * Captures a high-definition live frame:
     * - Keeps the animated cursor visible on screen for the user!
     * - Hides only `stopPillView` + top HUD text for ~14ms so the AI sees 100% of the real app cleanly.
     * - Produces `cleanUserBase64` (for live chat preview) + `calibratedAiBase64` (with crisp 0..1000
     *   coordinate ruler ticks along top & left edges so the AI hits exact icons & thumbnails!).
     */
    suspend fun captureLiveVisionFrame(settleMaxMs: Long = 650L, expectAwayFromBrief: Boolean = false): VisionFrame? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val sampled = awaitScreenSettle150Frames(settleMaxMs, expectAwayFromBrief)

        mainHandler.post {
            stopPillView?.visibility = View.INVISIBLE
            overlayView?.setBadgeHiddenForCapture(true)
        }
        delay(16L)

        val result = suspendCancellableCoroutine<VisionFrame?> { cont ->
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
                                val maxDim = 1360
                                val curMax = maxOf(swBmp.width, swBmp.height)
                                val cleanBmp = if (curMax > maxDim) {
                                    val ratio = maxDim.toFloat() / curMax.toFloat()
                                    val tw = (swBmp.width * ratio).toInt().coerceAtLeast(1)
                                    val th = (swBmp.height * ratio).toInt().coerceAtLeast(1)
                                    Bitmap.createScaledBitmap(swBmp, tw, th, true).also {
                                        if (it !== swBmp) swBmp.recycle()
                                    }
                                } else {
                                    swBmp
                                }

                                val cleanOut = ByteArrayOutputStream()
                                cleanBmp.compress(Bitmap.CompressFormat.JPEG, 82, cleanOut)
                                val cleanB64 = Base64.encodeToString(cleanOut.toByteArray(), Base64.NO_WRAP)

                                val aiBmp = drawCalibrationGridOnCopy(cleanBmp)
                                val w = cleanBmp.width
                                val h = cleanBmp.height
                                cleanBmp.recycle()

                                val aiOut = ByteArrayOutputStream()
                                aiBmp.compress(Bitmap.CompressFormat.JPEG, 85, aiOut)
                                aiBmp.recycle()
                                val aiB64 = Base64.encodeToString(aiOut.toByteArray(), Base64.NO_WRAP)

                                if (cont.isActive) {
                                    cont.resume(VisionFrame(cleanB64, aiB64, w, h, sampled))
                                }
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

        mainHandler.post {
            stopPillView?.visibility = View.VISIBLE
            overlayView?.setBadgeHiddenForCapture(false)
        }
        return result
    }

    suspend fun captureScreenshotJpegBase64(): String? {
        return captureLiveVisionFrame(settleMaxMs = 450L)?.calibratedAiBase64
    }

    private fun drawCalibrationGridOnCopy(src: Bitmap): Bitmap {
        val copy = src.copy(Bitmap.Config.ARGB_8888, true)
        val c = Canvas(copy)
        val w = copy.width.toFloat()
        val h = copy.height.toFloat()

        val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(46, 56, 189, 248)
            strokeWidth = 1f
        }
        val bgStripPaint = Paint().apply {
            color = Color.argb(150, 8, 12, 20)
        }
        val txtPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(235, 186, 230, 253)
            textSize = (minOf(w, h) * 0.019f).coerceIn(13f, 22f)
            typeface = Typeface.MONOSPACE
        }

        c.drawRect(0f, 0f, w, 20f, bgStripPaint)
        c.drawRect(0f, 0f, 34f, h, bgStripPaint)

        for (step in 1..9) {
            val nx = step * 100
            val gx = (nx / 1000f) * w
            val gy = (nx / 1000f) * h
            c.drawLine(gx, 0f, gx, h, linePaint)
            c.drawLine(0f, gy, w, gy, linePaint)
            c.drawText(nx.toString(), gx - 12f, 15f, txtPaint)
            c.drawText(nx.toString(), 2f, gy + 5f, txtPaint)
        }
        return copy
    }

    private suspend fun dispatchPath(path: Path, durationMs: Long): Boolean {
        agentGestureActive = true
        setStopPillPassThrough(true)
        delay(16L)
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceAtLeast(35L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val ok = try {
            suspendCancellableCoroutine<Boolean> { cont ->
                val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        if (cont.isActive) cont.resume(false)
                    }
                }, null)
                if (!dispatched && cont.isActive) cont.resume(false)
            }
        } finally {
            lastAgentGestureEndUptimeMs = SystemClock.uptimeMillis()
            agentGestureActive = false
            mainHandler.postDelayed({ setStopPillPassThrough(false) }, 220L)
        }
        return ok
    }

    private suspend fun glideCheckAndClickVisual(px: Float, py: Float) {
        val moveMs = configuredCursorSpeedMs.coerceIn(220L, 1400L)
        val checkMs = (moveMs * 0.34f).toLong().coerceIn(140L, 280L)
        mainHandler.post { overlayView?.animateMoveTo(px, py, moveMs) }
        delay(moveMs)
        mainHandler.post { overlayView?.animateCheckTarget(px, py, checkMs) }
        delay(checkMs)
        mainHandler.post { overlayView?.triggerRipple(px, py) }
    }

    suspend fun tapNormalized(nx: Double, ny: Double, longPress: Boolean = false): Boolean {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val px = DisplayUtils.normToPx(nx, w).coerceIn(4f, (w - 4).toFloat())
        val py = DisplayUtils.normToPx(ny, h).coerceIn(4f, (h - 4).toFloat())

        if (!configuredTouchTypingMode.equals("keyboard", ignoreCase = true)) {
            val hitRect = findTouchTargetBoundsAt(activeAppRoot(), px.toInt(), py.toInt(), 0)
            if (hitRect != null && hitRect.width() in 8..(w * 9 / 10) && hitRect.height() in 8..(h / 2)) {
                mainHandler.post {
                    overlayView?.triggerTouchTargetBox(
                        hitRect.left.toFloat(),
                        hitRect.top.toFloat(),
                        hitRect.right.toFloat(),
                        hitRect.bottom.toFloat(),
                        "Touch"
                    )
                }
            }
        }

        glideCheckAndClickVisual(px, py)

        val p = Path().apply { moveTo(px, py) }
        return dispatchPath(p, if (longPress) 720L else 60L)
    }

    private fun findTouchTargetBoundsAt(
        node: AccessibilityNodeInfo?,
        px: Int,
        py: Int,
        depth: Int
    ): Rect? {
        if (node == null || depth > 22 || !node.isVisibleToUser) return null
        var best: Rect? = null
        val r = Rect()
        node.getBoundsInScreen(r)
        if (r.contains(px, py) && (node.isClickable || node.isEditable || node.isFocusable)) {
            best = Rect(r)
        }
        val count = node.childCount
        for (i in 0 until count) {
            val child = node.getChild(i) ?: continue
            val sub = findTouchTargetBoundsAt(child, px, py, depth + 1)
            if (sub != null) {
                if (best == null || (sub.width().toLong() * sub.height().toLong()) <= (best.width().toLong() * best.height().toLong())) {
                    best = sub
                }
            }
        }
        return best
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

    suspend fun swipeNormalized(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Long = 420L): Boolean {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val sx = DisplayUtils.normToPx(x1, w).coerceIn(6f, (w - 6).toFloat())
        val sy = DisplayUtils.normToPx(y1, h).coerceIn(6f, (h - 6).toFloat())
        val ex = DisplayUtils.normToPx(x2, w).coerceIn(6f, (w - 6).toFloat())
        val ey = DisplayUtils.normToPx(y2, h).coerceIn(6f, (h - 6).toFloat())

        val approachMs = (configuredCursorSpeedMs * 0.65f).toLong().coerceIn(180L, 700L)
        mainHandler.post { overlayView?.animateMoveTo(sx, sy, approachMs) }
        delay(approachMs)
        val swipeMs = durationMs.coerceIn(200L, 1100L)
        mainHandler.post { overlayView?.animateMoveTo(ex, ey, swipeMs) }

        val p = Path().apply {
            moveTo(sx, sy)
            lineTo(ex, ey)
        }
        return dispatchPath(p, swipeMs)
    }

    private fun activeAppRoot(): AccessibilityNodeInfo? {
        // Prefer the interactive window that is NOT Brief's own overlay!
        val winList = runCatching { windows }.getOrNull()
        if (!winList.isNullOrEmpty()) {
            for (win in winList) {
                val r = win.root ?: continue
                val pkg = r.packageName?.toString().orEmpty()
                if (pkg.isNotEmpty() && pkg != packageName && pkg != "com.android.systemui") {
                    return r
                }
            }
        }
        val fallback = rootInActiveWindow
        if (fallback != null && fallback.packageName?.toString() != packageName) {
            return fallback
        }
        return fallback
    }

    private fun findFocusedOrFirstEditable(): AccessibilityNodeInfo? {
        val root = activeAppRoot() ?: return null
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable) return focused
        return findFirstEditable(root, 0)
    }

    suspend fun typeTextIntoFocused(text: String, submit: Boolean = true): Pair<Boolean, String> {
        if (text.isEmpty()) {
            return if (submit) pressEnterSmart() else (false to "Text to type was empty.")
        }
        var target = findFocusedOrFirstEditable()
            ?: return false to "No editable text box visible on screen. Tap the Search icon or input box first, then call type_text."

        val rect = Rect()
        target.getBoundsInScreen(rect)
        if (rect.width() > 4 && rect.height() > 4) {
            mainHandler.post {
                overlayView?.triggerTouchTargetBox(
                    rect.left.toFloat(),
                    rect.top.toFloat(),
                    rect.right.toFloat(),
                    rect.bottom.toFloat(),
                    "Input"
                )
            }
            glideCheckAndClickVisual(rect.exactCenterX(), rect.exactCenterY())
            dispatchPath(Path().apply { moveTo(rect.exactCenterX(), rect.exactCenterY()) }, 50L)
        }
        target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        // Wait for One UI / ColorOS / MagicOS / Gboard keyboard & fresh swapped EditText (YouTube/Chrome swap Search TextView -> EditText on tap!)
        delay(240L)

        target = findFocusedOrFirstEditable() ?: target
        target.getBoundsInScreen(rect)

        val keyMap = collectSoftKeyboardKeys()

        // Smooth visual live typing feedback across the real visible keyboard keys (or input bar) WITHOUT firing 25 stale SET_TEXT events!
        val previewLimit = text.length.coerceAtMost(24)
        val visStep = if (previewLimit > 12) 2 else 1
        var vIdx = visStep
        while (vIdx <= previewLimit) {
            val slice = text.substring(0, vIdx)
            val ch = slice.last().toString()
            val kp = keyMap[ch.lowercase()]
            val caretSpan = (rect.width() - 28).coerceAtLeast(24)
            val kx = kp?.first ?: (rect.left + 14 + ((vIdx * 12) % caretSpan)).toFloat()
            val ky = kp?.second ?: rect.exactCenterY()
            mainHandler.post {
                overlayView?.setTypingPreview(slice)
                overlayView?.triggerTouchKeystroke(kx, ky, ch)
            }
            delay(34L)
            vIdx += visStep
        }
        mainHandler.post { overlayView?.setTypingPreview(text) }

        // Method 1: Single clean atomic ACTION_SET_TEXT on the fresh focused EditText
        val setArgs = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        var typedOk = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setArgs)
        delay(90L)

        // Verify whether the text actually landed inside the field (catches WebViews, Compose inputs & custom OEM bars!)
        val checkNode = findFocusedOrFirstEditable() ?: target
        val actualNow = checkNode.text?.toString().orEmpty()
        val textLanded = typedOk && (actualNow.contains(text.take(minOf(4, text.length)), ignoreCase = true) || !checkNode.isEditable)

        if (!textLanded) {
            // Method 2 (Automatic Physical On-Screen Keyboard Touch Tapping): tap real visible keys right in front of Brief!
            val canTapAllKeys = keyMap.isNotEmpty() && text.length <= 42 && text.all { c ->
                keyMap.containsKey(c.lowercase()) || (c == ' ' && keyMap.containsKey(" "))
            }
            if (canTapAllKeys) {
                var allTapped = true
                for (c in text) {
                    val lookup = if (c == ' ') " " else c.lowercase()
                    val pt = keyMap[lookup]
                    if (pt == null) {
                        allTapped = false
                        break
                    }
                    if (c.isUpperCase()) {
                        keyMap["shift"]?.let { sh ->
                            dispatchPath(Path().apply { moveTo(sh.first, sh.second) }, 42L)
                            delay(45L)
                        }
                    }
                    mainHandler.post { overlayView?.triggerTouchKeystroke(pt.first, pt.second, c.toString()) }
                    dispatchPath(Path().apply { moveTo(pt.first, pt.second) }, 45L)
                    delay(55L)
                }
                if (allTapped) typedOk = true
            }

            // Method 3 (Automatic Clipboard Paste Fallback for Unicode / non-keyboard symbols / WebViews):
            if (!typedOk) {
                runCatching {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("brief_input", text))
                }
                delay(40L)
                val pasteNode = findFocusedOrFirstEditable() ?: target
                typedOk = pasteNode.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            }
        }

        val freshAfterType = findFocusedOrFirstEditable() ?: target
        val idHint = "${freshAfterType.viewIdResourceName.orEmpty()} ${freshAfterType.hintText?.toString().orEmpty()} ${freshAfterType.contentDescription?.toString().orEmpty()}".lowercase()
        val isSearchField = idHint.contains("search") || idHint.contains("query") || idHint.contains("url") || idHint.contains("بحث")
        val shouldSubmit = submit || isSearchField

        if (typedOk && shouldSubmit) {
            val (_, enterDetail) = pressEnterOrSubmitActiveInput(text, rect.bottom)
            return true to "Typed \"$text\" cleanly ($enterDetail)."
        }

        return typedOk to (if (typedOk) {
            "Typed \"$text\" cleanly."
        } else {
            "Input field did not accept text; tap directly on the text area or visible keyboard keys."
        })
    }

    suspend fun pressEnterSmart(): Pair<Boolean, String> {
        val cur = findFocusedOrFirstEditable()
        val r = Rect()
        cur?.getBoundsInScreen(r)
        val q = cur?.text?.toString().orEmpty()
        return pressEnterOrSubmitActiveInput(q, if (r.bottom > 0) r.bottom else 220)
    }

    private data class ActionTarget(
        val node: AccessibilityNodeInfo?,
        val x: Float,
        val y: Float,
        val rect: Rect?,
        val label: String
    )

    private suspend fun pressEnterOrSubmitActiveInput(queryHint: String, inputBottomPx: Int): Pair<Boolean, String> {
        delay(120L)
        val beforeSig = quickTreeSignature(activeAppRoot())
        val editBefore = findFocusedOrFirstEditable()

        // 1. Try standard Android R+ ACTION_IME_ENTER on the fresh focused input node first
        var imeSent = false
        if (editBefore != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            imeSent = editBefore.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        }
        if (imeSent) {
            delay(280L)
            val afterSig = quickTreeSignature(activeAppRoot())
            val stillFocusedEditable = activeAppRoot()?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.isEditable == true
            if (!stillFocusedEditable && afterSig != beforeSig) {
                return true to "submitted via IME Enter"
            }
        }

        // 2. Inspect the LIVE on-screen keyboard window (One UI HoneyBoard, ColorOS, MagicOS, HyperOS, Gboard, SwiftKey) & app bar!
        val enterBtn = findLiveEnterOrSearchButton(inputBottomPx)
        if (enterBtn != null) {
            enterBtn.rect?.let { er ->
                if (er.width() > 4 && er.height() > 4) {
                    mainHandler.post {
                        overlayView?.triggerTouchTargetBox(
                            er.left.toFloat(),
                            er.top.toFloat(),
                            er.right.toFloat(),
                            er.bottom.toFloat(),
                            enterBtn.label
                        )
                    }
                }
            }
            glideCheckAndClickVisual(enterBtn.x, enterBtn.y)
            mainHandler.post { overlayView?.triggerTouchKeystroke(enterBtn.x, enterBtn.y, "⏎") }
            val clickedNode = if (enterBtn.node != null) clickNodeOrAncestor(enterBtn.node) else false
            if (!clickedNode) {
                dispatchPath(Path().apply { moveTo(enterBtn.x, enterBtn.y) }, 55L)
            }
            delay(320L)
            val stillEditingAfterBtn = activeAppRoot()?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.isEditable == true
            if (!stillEditingAfterBtn) {
                return true to "tapped live '${enterBtn.label}' button"
            }
        }

        // 3. Check if a live autocomplete/search suggestion row matching queryHint is waiting right below the input bar
        val qLower = queryHint.trim().lowercase()
        if (qLower.isNotEmpty()) {
            val suggestion = findSearchSuggestionNode(activeAppRoot(), qLower, inputBottomPx, 0)
            if (suggestion != null) {
                val sr = Rect()
                suggestion.getBoundsInScreen(sr)
                if (sr.width() > 4 && sr.height() > 4) {
                    mainHandler.post {
                        overlayView?.triggerTouchTargetBox(
                            sr.left.toFloat(),
                            sr.top.toFloat(),
                            sr.right.toFloat(),
                            sr.bottom.toFloat(),
                            "Search"
                        )
                    }
                    glideCheckAndClickVisual(sr.exactCenterX(), sr.exactCenterY())
                    if (!clickNodeOrAncestor(suggestion)) {
                        dispatchPath(Path().apply { moveTo(sr.exactCenterX(), sr.exactCenterY()) }, 55L)
                    }
                    return true to "tapped matching search suggestion"
                }
            }
        }

        return (imeSent || enterBtn != null) to "submitted Enter/Search"
    }

    private fun isImeWindow(win: AccessibilityWindowInfo, root: AccessibilityNodeInfo): Boolean {
        if (win.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true
        val pkg = root.packageName?.toString()?.lowercase().orEmpty()
        return pkg.contains("inputmethod") ||
            pkg.contains("keyboard") ||
            pkg.contains("honeyboard") || // Samsung One UI
            pkg.contains("swiftkey") ||   // Honor MagicOS / Microsoft SwiftKey
            pkg.contains("baidu") ||      // Huawei / Honor / Vivo OEM IME
            pkg.contains("sohu") ||
            pkg.contains("iflytek") ||
            pkg.contains("oplus") ||      // Oppo / Realme / OnePlus ColorOS IME
            pkg.contains("coloros") ||
            pkg.contains("latin")         // Gboard / AOSP
    }

    private fun findLiveEnterOrSearchButton(inputBottomPx: Int): ActionTarget? {
        val (screenW, screenH) = DisplayUtils.getRealScreenSize(this)
        val winList = runCatching { windows }.getOrNull().orEmpty()

        // Pass A: Look inside all visible IME keyboard windows (One UI, ColorOS, MagicOS, Gboard, SwiftKey)
        var imeBoundsFallback: Rect? = null
        var bestBottomRightKey: ActionTarget? = null

        for (win in winList) {
            val root = win.root ?: continue
            if (!isImeWindow(win, root)) continue
            val wb = Rect()
            win.getBoundsInScreen(wb)
            if (wb.width() > screenW / 3 && wb.height() > (48 * resources.displayMetrics.density).toInt()) {
                imeBoundsFallback = wb
            }
            val labeled = scanForEnterActionNode(root, wb, isIme = true, depth = 0)
            if (labeled != null) return labeled

            // Also track the bottom-most, right-most clickable key inside the keyboard body (excluding bottom nav switcher strip!)
            val cornerKey = findBottomRightImeKeyNode(root, wb, screenH, 0)
            if (cornerKey != null) bestBottomRightKey = cornerKey
        }

        // Pass B: Look in the foreground app window for an adjacent Search / Go / Send button near the input bar!
        activeAppRoot()?.let { appRoot ->
            val appAction = scanForInAppSendOrSearchButton(appRoot, inputBottomPx, 0)
            if (appAction != null) return appAction
        }

        if (bestBottomRightKey != null) return bestBottomRightKey

        // Pass C: Geometry derived from the ACTUAL live IME window rectangle (adapts automatically to One UI nav bar, MagicOS split/tablet bar, ColorOS & landscape!)
        if (imeBoundsFallback != null) {
            val b = imeBoundsFallback
            // Exclude bottom ~42dp keyboard-switcher / gesture bar if keyboard touches bottom of screen
            val navTrim = if (b.bottom >= screenH - (8 * resources.displayMetrics.density).toInt()) {
                (40f * resources.displayMetrics.density)
            } else 0f
            val usableBottom = (b.bottom.toFloat() - navTrim).coerceAtLeast(b.top + b.height() * 0.65f)
            val ex = (b.right - b.width() * 0.075f).coerceIn(12f, screenW - 12f)
            val ey = (usableBottom - (b.height() * 0.11f)).coerceIn(b.top + 12f, screenH - 12f)
            return ActionTarget(null, ex, ey, null, "Keyboard Enter")
        }

        return null
    }

    private fun scanForEnterActionNode(
        node: AccessibilityNodeInfo?,
        imeRect: Rect,
        isIme: Boolean,
        depth: Int
    ): ActionTarget? {
        if (node == null || depth > 18 || !node.isVisibleToUser) return null
        val txt = node.text?.toString()?.trim().orEmpty()
        val desc = node.contentDescription?.toString()?.trim().orEmpty()
        val resId = node.viewIdResourceName?.substringAfterLast('/')?.lowercase().orEmpty()
        val combined = "$txt $desc".lowercase()

        val idMatch = resId == "key_pos_ime_action" ||
            resId == "ime_action" ||
            resId == "key_enter" ||
            resId == "enter" ||
            resId == "enter_key" ||
            resId == "action_key" ||
            resId == "btn_enter" ||
            resId.contains("ime_action") ||
            resId.endsWith("_enter")

        val exactWords = setOf(
            "search", "enter", "go", "send", "done", "next", "submit", "return",
            "بحث", "إدخال", "ادخال", "إرسال", "ارسال", "تم", "ذهاب", "التالي",
            "↵", "⏎", "🔍"
        )
        val labelMatch = exactWords.any { w ->
            txt.equals(w, ignoreCase = true) ||
                desc.equals(w, ignoreCase = true) ||
                combined.split(Regex("[\\s,;:()]+")).any { tok -> tok == w }
        } || desc.contains("search", ignoreCase = true) ||
            desc.contains("enter", ignoreCase = true) ||
            desc.contains("send", ignoreCase = true) ||
            desc.contains("go", ignoreCase = true) ||
            desc.contains("بحث") ||
            desc.contains("إرسال") ||
            desc.contains("إدخال")

        if (idMatch || (isIme && labelMatch)) {
            val r = Rect()
            node.getBoundsInScreen(r)
            if (r.width() > 8 && r.height() > 8) {
                // Make sure we didn't match a voice/mic or emoji search button on the top toolbar of the keyboard!
                val notMicOrEmoji = !combined.contains("voice") &&
                    !combined.contains("emoji") &&
                    !combined.contains("gif") &&
                    !combined.contains("sticker") &&
                    !resId.contains("voice") &&
                    !resId.contains("mic") &&
                    !resId.contains("emoji") &&
                    (imeRect.height() <= 0 || r.centerY() >= imeRect.top + imeRect.height() * 0.25f)
                if (notMicOrEmoji) {
                    val nice = txt.ifEmpty { desc.ifEmpty { "Enter" } }.take(18)
                    return ActionTarget(node, r.exactCenterX(), r.exactCenterY(), r, nice)
                }
            }
        }

        for (i in 0 until node.childCount) {
            val hit = scanForEnterActionNode(node.getChild(i), imeRect, isIme, depth + 1)
            if (hit != null) return hit
        }
        return null
    }

    private fun findBottomRightImeKeyNode(
        node: AccessibilityNodeInfo?,
        imeRect: Rect,
        screenH: Int,
        depth: Int
    ): ActionTarget? {
        if (node == null || depth > 16 || !node.isVisibleToUser) return null
        var best: ActionTarget? = null
        val dp = resources.displayMetrics.density
        val navCutoffY = screenH - (34f * dp).toInt()
        if (node.isClickable) {
            val r = Rect()
            node.getBoundsInScreen(r)
            val resId = node.viewIdResourceName?.substringAfterLast('/')?.lowercase().orEmpty()
            val desc = "${node.text.orEmpty()} ${node.contentDescription.orEmpty()}".lowercase()
            val isHideOrSwitch = desc.contains("hide") || desc.contains("switch") || desc.contains("language") ||
                desc.contains("delete") || desc.contains("backspace") || resId.contains("backspace") || resId.contains("delete")
            if (!isHideOrSwitch &&
                r.width() in (24 * dp).toInt()..(180 * dp).toInt() &&
                r.height() in (24 * dp).toInt()..(110 * dp).toInt() &&
                r.right >= imeRect.right - (imeRect.width() * 0.24f).toInt() &&
                r.bottom <= navCutoffY &&
                r.centerY() >= imeRect.top + (imeRect.height() * 0.45f).toInt()
            ) {
                best = ActionTarget(node, r.exactCenterX(), r.exactCenterY(), r, "Enter")
            }
        }
        for (i in 0 until node.childCount) {
            val sub = findBottomRightImeKeyNode(node.getChild(i), imeRect, screenH, depth + 1)
            if (sub != null) {
                if (best == null || (sub.x + sub.y * 1.4f) > (best.x + best.y * 1.4f)) {
                    best = sub
                }
            }
        }
        return best
    }

    private fun scanForInAppSendOrSearchButton(
        node: AccessibilityNodeInfo?,
        inputBottomPx: Int,
        depth: Int
    ): ActionTarget? {
        if (node == null || depth > 22 || !node.isVisibleToUser) return null
        if (node.isClickable && !node.isEditable) {
            val txt = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            val resId = node.viewIdResourceName?.substringAfterLast('/')?.lowercase().orEmpty()
            val isSubmitBtn = desc.equals("send", true) ||
                desc.equals("go", true) ||
                desc.equals("submit", true) ||
                desc.equals("إرسال", true) ||
                txt.equals("send", true) ||
                txt.equals("go", true) ||
                resId == "send_button" ||
                resId == "search_go_btn"
            if (isSubmitBtn) {
                val r = Rect()
                node.getBoundsInScreen(r)
                if (r.width() > 8 && r.height() > 8 && abs(r.centerY() - inputBottomPx) < (140 * resources.displayMetrics.density)) {
                    return ActionTarget(node, r.exactCenterX(), r.exactCenterY(), r, desc.ifEmpty { txt.ifEmpty { "Send" } })
                }
            }
        }
        for (i in 0 until node.childCount) {
            val hit = scanForInAppSendOrSearchButton(node.getChild(i), inputBottomPx, depth + 1)
            if (hit != null) return hit
        }
        return null
    }

    private fun collectSoftKeyboardKeys(): Map<String, Pair<Float, Float>> {
        val out = HashMap<String, Pair<Float, Float>>()
        val winList = runCatching { windows }.getOrNull() ?: return out
        for (win in winList) {
            val root = win.root ?: continue
            if (isImeWindow(win, root)) {
                scanImeKeysRecursive(root, out, 0)
            }
        }
        return out
    }

    private fun scanImeKeysRecursive(
        node: AccessibilityNodeInfo?,
        out: MutableMap<String, Pair<Float, Float>>,
        depth: Int
    ) {
        if (node == null || depth > 16 || !node.isVisibleToUser) return
        val rawLbl = (node.text?.toString()?.takeIf { it.isNotBlank() } ?: node.contentDescription?.toString()).orEmpty().trim()
        if (rawLbl.isNotEmpty()) {
            val r = Rect()
            node.getBoundsInScreen(r)
            if (r.width() > 4 && r.height() > 4) {
                val lower = rawLbl.lowercase()
                val key = when {
                    rawLbl.length == 1 -> lower
                    lower == "space" || lower.contains("space bar") || lower.contains("مسافة") -> " "
                    lower.contains("shift") || lower.contains("caps") || lower.contains("عالي") -> "shift"
                    else -> lower.take(1)
                }
                if (!out.containsKey(key)) {
                    out[key] = r.exactCenterX() to r.exactCenterY()
                }
            }
        }
        val count = node.childCount
        for (i in 0 until count) {
            scanImeKeysRecursive(node.getChild(i), out, depth + 1)
        }
    }

    private fun clickNodeOrAncestor(node: AccessibilityNodeInfo?): Boolean {
        var cur = node
        var hops = 0
        while (cur != null && !cur.isClickable && hops < 5) {
            cur = cur.parent
            hops++
        }
        return cur?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    private fun findSearchSuggestionNode(
        node: AccessibilityNodeInfo?,
        queryLower: String,
        minTopPx: Int,
        depth: Int
    ): AccessibilityNodeInfo? {
        if (node == null || depth > 24) return null
        if (node.isVisibleToUser && !node.isEditable) {
            val txt = node.text?.toString()?.trim()?.lowercase().orEmpty()
            if (txt.isNotEmpty() && (txt == queryLower || txt.startsWith(queryLower))) {
                val r = Rect()
                node.getBoundsInScreen(r)
                if (r.top >= minTopPx - 12 && r.width() > 10 && r.height() > 10) {
                    return node
                }
            }
        }
        for (i in 0 until node.childCount) {
            val hit = findSearchSuggestionNode(node.getChild(i), queryLower, minTopPx, depth + 1)
            if (hit != null) return hit
        }
        return null
    }

    suspend fun tapElementByLabel(query: String): Pair<Boolean, String> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return false to "Element label cannot be empty."
        // If AI specifically asks to tap Enter / Search / Go / Send while an input or IME keyboard is active, check live IME action button too!
        if (q in setOf("enter", "return", "go", "submit", "إدخال", "ذهاب") ||
            ((q == "search" || q == "بحث" || q == "send" || q == "إرسال") && findFocusedOrFirstEditable() != null)
        ) {
            val imeHit = findLiveEnterOrSearchButton(220)
            if (imeHit != null && (q != "search" || imeHit.label.contains("search", true) || imeHit.label.contains("بحث") || imeHit.label.contains("enter", true))) {
                glideCheckAndClickVisual(imeHit.x, imeHit.y)
                val okNode = if (imeHit.node != null) clickNodeOrAncestor(imeHit.node) else false
                if (!okNode) dispatchPath(Path().apply { moveTo(imeHit.x, imeHit.y) }, 55L)
                return true to "Checked and tapped keyboard '${imeHit.label}' button cleanly."
            }
        }
        val root = activeAppRoot() ?: return false to "No active screen window."
        var match = findNodeByLabel(root, q, exact = true, depth = 0)
            ?: findNodeByLabel(root, q, exact = false, depth = 0)
        if (match == null) {
            val winList = runCatching { windows }.getOrNull().orEmpty()
            for (win in winList) {
                val r = win.root ?: continue
                if (isImeWindow(win, r)) {
                    match = findNodeByLabel(r, q, exact = true, depth = 0)
                        ?: findNodeByLabel(r, q, exact = false, depth = 0)
                    if (match != null) break
                }
            }
        }
        if (match == null) return false to "No visible element matching \"$query\" found on screen."

        val rect = Rect()
        match.getBoundsInScreen(rect)
        val cx = rect.exactCenterX()
        val cy = rect.exactCenterY()
        if (rect.width() > 2 && rect.height() > 2) {
            glideCheckAndClickVisual(cx, cy)
        }

        if (clickNodeOrAncestor(match)) {
            return true to "Checked and tapped \"$query\" cleanly."
        }
        if (rect.width() > 2 && rect.height() > 2) {
            val p = Path().apply { moveTo(cx, cy) }
            val gestureOk = dispatchPath(p, 60L)
            return gestureOk to (if (gestureOk) "Checked and tapped \"$query\" at (${cx.toInt()}, ${cy.toInt()})." else "Gesture tap cancelled.")
        }
        return false to "Could not click \"$query\"."
    }

    private fun findNodeByLabel(
        node: AccessibilityNodeInfo?,
        q: String,
        exact: Boolean,
        depth: Int
    ): AccessibilityNodeInfo? {
        if (node == null || depth > 28) return null
        if (node.packageName?.toString() == packageName) return null
        if (node.isVisibleToUser) {
            val txt = node.text?.toString()?.trim()?.lowercase().orEmpty()
            val desc = node.contentDescription?.toString()?.trim()?.lowercase().orEmpty()
            val resId = node.viewIdResourceName?.substringAfterLast('/')?.lowercase().orEmpty()
            val hit = if (exact) {
                txt == q || desc == q || resId == q
            } else {
                txt.contains(q) || desc.contains(q) || (q.length >= 4 && resId.contains(q))
            }
            if (hit) return node
        }
        for (i in 0 until node.childCount) {
            val found = findNodeByLabel(node.getChild(i), q, exact, depth + 1)
            if (found != null) return found
        }
        return null
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
        if (node == null || depth > 24) return null
        if (node.packageName?.toString() == packageName) return null
        if (node.isEditable && node.isVisibleToUser) return node
        for (i in 0 until node.childCount) {
            val hit = findFirstEditable(node.getChild(i), depth + 1)
            if (hit != null) return hit
        }
        return null
    }

    fun readScreenElements(maxElements: Int = 150): JSONObject {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val root = activeAppRoot()
        val rawItems = mutableListOf<JSONObject>()
        val pkg = root?.packageName?.toString().orEmpty()
        if (root != null && pkg != packageName) {
            collectNodes(root, w.coerceAtLeast(1), h.coerceAtLeast(1), rawItems, maxElements - 4, 0)
        }
        // Also surface the live on-screen keyboard's Enter / Search / Go / Send button (One UI, ColorOS, MagicOS, Gboard) in the UI map so ALL 4 AIs see its exact (x, y)!
        val imeEnter = findLiveEnterOrSearchButton(220)
        if (imeEnter != null && w > 0 && h > 0) {
            val ex = ((imeEnter.x / w.toFloat()) * 1000.0).toInt().coerceIn(0, 1000)
            val ey = ((imeEnter.y / h.toFloat()) * 1000.0).toInt().coerceIn(0, 1000)
            rawItems.add(
                JSONObject().apply {
                    put("label", "[KEYBOARD_ENTER_KEY] ${imeEnter.label}")
                    put("x", ex)
                    put("y", ey)
                    put("clickable", true)
                }
            )
        }
        rawItems.sortWith(compareBy({ it.optInt("y", 0) }, { it.optInt("x", 0) }))
        val arr = JSONArray()
        for (item in rawItems) arr.put(item)
        return JSONObject().apply {
            put("packageName", pkg)
            put("screenWidth", w)
            put("screenHeight", h)
            put("count", arr.length())
            put("elements", arr)
        }
    }

    private fun collectNodes(
        node: AccessibilityNodeInfo?,
        w: Int,
        h: Int,
        out: MutableList<JSONObject>,
        maxElements: Int,
        depth: Int
    ) {
        if (node == null || depth > 28 || out.size >= maxElements) return
        if (node.packageName?.toString() == packageName) return
        if (node.isVisibleToUser) {
            val txt = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            val resId = node.viewIdResourceName?.substringAfterLast('/').orEmpty()
            val label = when {
                txt.isNotEmpty() && desc.isNotEmpty() && !txt.equals(desc, ignoreCase = true) -> "$txt ($desc)"
                txt.isNotEmpty() -> txt
                desc.isNotEmpty() -> desc
                node.isClickable && resId.isNotEmpty() -> "[icon:$resId]"
                else -> ""
            }
            if (label.isNotEmpty() || node.isEditable) {
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if (rect.width() > 6 && rect.height() > 6 && rect.bottom > 0 && rect.right > 0) {
                    val cx = ((rect.exactCenterX() / w.toFloat()) * 1000.0).toInt().coerceIn(0, 1000)
                    val cy = ((rect.exactCenterY() / h.toFloat()) * 1000.0).toInt().coerceIn(0, 1000)
                    out.add(JSONObject().apply {
                        put("label", label.take(110))
                        if (resId.isNotEmpty()) put("id", resId.take(40))
                        put("x", cx)
                        put("y", cy)
                        if (node.isClickable) put("clickable", true)
                        if (node.isEditable) put("editable", true)
                        if (node.isFocused) put("focused", true)
                    })
                }
            }
        }
        for (i in 0 until node.childCount) {
            if (out.size >= maxElements) break
            collectNodes(node.getChild(i), w, h, out, maxElements, depth + 1)
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
