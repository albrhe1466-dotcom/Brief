package com.brief.desktop

import android.content.Context
import android.graphics.*
import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.pow
import kotlin.math.sin

/**
 * Exact PC-Matched Hardware-Accelerated Cursor & Screen Frame Overlay for Android Phones & Tablets
 * (mirroring `src/renderer/cursor-overlay.html` on Windows & Linux laptops):
 *
 * 1. Glowing provider border + 4 rounded corner brackets (`tl`, `tr`, `bl`, `br`) + top control banner
 *    (Blue for Gemini, Crisp White for OpenAI, Warm Orange for Claude, Indigo-Violet for OpenRouter).
 * 2. Proportional device scale: Phones smallest (22dp) -> Tablets medium (28dp) -> Computers full size.
 * 3. Floating dark `.cursor-pill` with pulsing provider dot + action label + live monospace typing preview
 *    attached right beside the moving cursor arrow (clamped cleanly inside screen edges).
 * 4. Smooth `Choreographer` VSYNC curved glide, target-check reticle, pointer press bounce, and
 *    radial-gradient expanding click ripples (`scale 0.35 -> 3.6`).
 */
class CursorOverlayView(context: Context) : View(context) {
    private var provider: ProviderId = ProviderId.GEMINI
    private val isTabletDevice: Boolean = OemCompatibilityHelper.isTablet(context)

    private var cursorX: Float = -1f
    private var cursorY: Float = -1f
    private var cursorVisible: Boolean = false
    private var chromeHiddenForCapture: Boolean = false
    private var statusText: String = "Ready"
    private var typingPreview: String = ""

    // Smooth curved Bezier glide state
    private var moveStartX: Float = 0f
    private var moveStartY: Float = 0f
    private var moveCtrlX: Float = 0f
    private var moveCtrlY: Float = 0f
    private var moveTargetX: Float = 0f
    private var moveTargetY: Float = 0f
    private var moveStartMs: Long = 0L
    private var moveDurationMs: Long = 560L
    private var moveAnimating: Boolean = false

    // Target inspection ("checking") reticle
    private var checkX: Float = 0f
    private var checkY: Float = 0f
    private var checkStartMs: Long = 0L
    private var checkDurationMs: Long = 220L
    private var checkProgress: Float = 0f
    private var checkActive: Boolean = false

    // Radial-gradient PC click ripple + press bounce
    private var rippleX: Float = 0f
    private var rippleY: Float = 0f
    private var rippleStartMs: Long = 0L
    private var rippleDurationMs: Long = 440L
    private var rippleProgress: Float = 1f
    private var rippleActive: Boolean = false
    private var clickScale: Float = 1f

    // v2.1.0-beta Touch Screen Target Highlight Box & Live Keystroke Touch Pulse
    private val touchTargetRect = RectF()
    private var touchTargetLabel: String = ""
    private var touchTargetStartMs: Long = 0L
    private var touchTargetDurationMs: Long = 680L
    private var touchTargetProgress: Float = 1f
    private var touchTargetActive: Boolean = false

    private var keyPulseX: Float = 0f
    private var keyPulseY: Float = 0f
    private var keyPulseChar: String = ""
    private var keyPulseStartMs: Long = 0L
    private var keyPulseDurationMs: Long = 190L
    private var keyPulseProgress: Float = 1f
    private var keyPulseActive: Boolean = false

    private var vsyncScheduled: Boolean = false
    private val dp = resources.displayMetrics.density

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val rippleStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = (if (isTabletDevice) 2.5f else 2.0f) * dp
    }
    private val rippleFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val pillBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xEE0A0C12.toInt()
    }
    private val bannerTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = (if (isTabletDevice) 11.2f else 9.8f) * dp
        typeface = Typeface.DEFAULT_BOLD
    }
    private val cursorLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = (if (isTabletDevice) 10.8f else 9.4f) * dp
        typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
    }
    private val typingTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF93C5FD.toInt()
        textSize = (if (isTabletDevice) 10.6f else 9.2f) * dp
        typeface = Typeface.MONOSPACE
    }

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            vsyncScheduled = false
            val now = SystemClock.uptimeMillis()
            var keepRunning = false

            if (moveAnimating) {
                val rawT = ((now - moveStartMs).toFloat() / moveDurationMs.toFloat()).coerceIn(0f, 1f)
                // Exact cubic/quintic ease-in-out matching PC cursor-overlay.html
                val t = if (rawT < 0.5f) {
                    4f * rawT * rawT * rawT
                } else {
                    1f - (-2f * rawT + 2f).pow(3) / 2f
                }
                val inv = 1f - t
                cursorX = inv * inv * moveStartX + 2f * inv * t * moveCtrlX + t * t * moveTargetX
                cursorY = inv * inv * moveStartY + 2f * inv * t * moveCtrlY + t * t * moveTargetY
                if (rawT >= 1f) {
                    cursorX = moveTargetX
                    cursorY = moveTargetY
                    moveAnimating = false
                } else {
                    keepRunning = true
                }
            }

            if (checkActive) {
                val rawC = ((now - checkStartMs).toFloat() / checkDurationMs.toFloat()).coerceIn(0f, 1f)
                checkProgress = rawC
                if (rawC >= 1f) checkActive = false else keepRunning = true
            }

            if (rippleActive) {
                val rawR = ((now - rippleStartMs).toFloat() / rippleDurationMs.toFloat()).coerceIn(0f, 1f)
                rippleProgress = 1f - (1f - rawR).pow(2.6f)
                clickScale = when {
                    rawR < 0.22f -> 1f - 0.18f * (rawR / 0.22f)
                    rawR < 0.55f -> 0.82f + 0.23f * ((rawR - 0.22f) / 0.33f)
                    rawR < 0.82f -> 1.05f - 0.05f * ((rawR - 0.55f) / 0.27f)
                    else -> 1f
                }
                if (rawR >= 1f) {
                    rippleActive = false
                    clickScale = 1f
                } else {
                    keepRunning = true
                }
            } else {
                clickScale = 1f
            }

            if (touchTargetActive) {
                val rawBox = ((now - touchTargetStartMs).toFloat() / touchTargetDurationMs.toFloat()).coerceIn(0f, 1f)
                touchTargetProgress = rawBox
                if (rawBox >= 1f) touchTargetActive = false else keepRunning = true
            }

            if (keyPulseActive) {
                val rawKp = ((now - keyPulseStartMs).toFloat() / keyPulseDurationMs.toFloat()).coerceIn(0f, 1f)
                keyPulseProgress = rawKp
                if (rawKp >= 1f) keyPulseActive = false else keepRunning = true
            }

            invalidate()
            if (keepRunning) scheduleVsync()
        }
    }

    init {
        setLayerType(LAYER_TYPE_HARDWARE, null)
        setBackgroundColor(Color.TRANSPARENT)
    }

    private fun scheduleVsync() {
        if (!vsyncScheduled) {
            vsyncScheduled = true
            Choreographer.getInstance().postFrameCallback(frameCallback)
        }
    }

    fun setState(p: ProviderId, status: String) {
        provider = p
        statusText = status.take(48)
        if (!status.contains("Typ", ignoreCase = true)) {
            typingPreview = ""
        }
        if (!cursorVisible) {
            val dm = resources.displayMetrics
            cursorX = dm.widthPixels * 0.5f
            cursorY = dm.heightPixels * 0.52f
            cursorVisible = true
        }
        invalidate()
    }

    fun setTypingPreview(text: String) {
        typingPreview = text.take(26)
        invalidate()
    }

    fun setBadgeHiddenForCapture(hidden: Boolean) {
        chromeHiddenForCapture = hidden
        invalidate()
    }

    fun animateMoveTo(tx: Float, ty: Float, durationMs: Long = 560L) {
        val dm = resources.displayMetrics
        if (!cursorVisible || cursorX < 0f || cursorY < 0f) {
            cursorX = dm.widthPixels * 0.5f
            cursorY = dm.heightPixels * 0.52f
            cursorVisible = true
        }
        moveStartX = cursorX
        moveStartY = cursorY
        moveTargetX = tx
        moveTargetY = ty

        val dx = tx - moveStartX
        val dy = ty - moveStartY
        val dist = hypot(dx, dy)
        val midX = (moveStartX + tx) * 0.5f
        val midY = (moveStartY + ty) * 0.5f
        if (dist > 18f * dp) {
            val angle = atan2(dy, dx) + (Math.PI / 2.0).toFloat()
            val arc = (dist * 0.10f).coerceAtMost(24f * dp)
            moveCtrlX = midX + cos(angle) * arc
            moveCtrlY = midY + sin(angle) * arc
        } else {
            moveCtrlX = midX
            moveCtrlY = midY
        }

        moveStartMs = SystemClock.uptimeMillis()
        moveDurationMs = durationMs.coerceIn(180L, 1600L)
        moveAnimating = true
        cursorVisible = true
        scheduleVsync()
    }

    fun animateCheckTarget(tx: Float, ty: Float, durationMs: Long = 210L) {
        checkX = tx
        checkY = ty
        checkStartMs = SystemClock.uptimeMillis()
        checkDurationMs = durationMs.coerceIn(100L, 600L)
        checkProgress = 0f
        checkActive = true
        scheduleVsync()
    }

    fun triggerRipple(x: Float, y: Float) {
        rippleX = x
        rippleY = y
        rippleStartMs = SystemClock.uptimeMillis()
        rippleProgress = 0f
        rippleActive = true
        scheduleVsync()
    }

    fun triggerTouchTargetBox(left: Float, top: Float, right: Float, bottom: Float, label: String = "") {
        val pad = 4f * dp
        touchTargetRect.set(left - pad, top - pad, right + pad, bottom + pad)
        touchTargetLabel = label.take(26)
        touchTargetStartMs = SystemClock.uptimeMillis()
        touchTargetProgress = 0f
        touchTargetActive = true
        scheduleVsync()
    }

    fun triggerTouchKeystroke(x: Float, y: Float, ch: String = "") {
        keyPulseX = x
        keyPulseY = y
        keyPulseChar = ch.take(2)
        keyPulseStartMs = SystemClock.uptimeMillis()
        keyPulseProgress = 0f
        keyPulseActive = true
        scheduleVsync()
    }

    private fun providerFrameAccent(): Int = when (provider) {
        // Matches PC cursor-overlay.html: Gemini=Blue, OpenAI=Crisp White, Claude=Orange, OpenRouter=Indigo
        ProviderId.GEMINI -> 0xFF3B82F6.toInt()
        ProviderId.OPENAI -> 0xFFFFFFFF.toInt()
        ProviderId.ANTHROPIC -> 0xFFF97316.toInt()
        ProviderId.OPENROUTER -> 0xFF818CF8.toInt()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val accent = providerFrameAccent()

        // 1. PC-style provider screen edge border + 4 corner brackets + top banner (hidden for 14ms during screenshot)
        if (!chromeHiddenForCapture) {
            drawPcLayoutFrameAndCorners(canvas, w, h, accent)
            drawTopControlBanner(canvas, w, accent)
        }

        // 2. Live Touch Screen Target Highlight Box (shows exact button / input Brief is clicking)
        if (touchTargetActive && !chromeHiddenForCapture && touchTargetRect.width() > 6f && touchTargetRect.height() > 6f) {
            val fade = (1f - touchTargetProgress * 0.78f).coerceIn(0f, 1f)
            val fillA = (fade * 46f).toInt().coerceIn(0, 255)
            val strokeA = (fade * 238f).toInt().coerceIn(0, 255)
            val rx = 10f * dp
            fillPaint.color = (accent and 0x00FFFFFF) or (fillA shl 24)
            canvas.drawRoundRect(touchTargetRect, rx, rx, fillPaint)
            strokePaint.color = (accent and 0x00FFFFFF) or (strokeA shl 24)
            strokePaint.strokeWidth = (if (isTabletDevice) 2.6f else 2.1f) * dp
            canvas.drawRoundRect(touchTargetRect, rx, rx, strokePaint)
        }

        // 2b. Live Touch Screen Keystroke Pulse (flashes touched key / caret as Brief types)
        if (keyPulseActive && !chromeHiddenForCapture) {
            val fade = (1f - keyPulseProgress).coerceIn(0f, 1f)
            val kr = ((if (isTabletDevice) 18f else 14f) * dp) * (0.72f + 0.45f * keyPulseProgress)
            fillPaint.color = (accent and 0x00FFFFFF) or ((fade * 92f).toInt().coerceIn(0, 255) shl 24)
            canvas.drawCircle(keyPulseX, keyPulseY, kr, fillPaint)
            rippleStrokePaint.color = (accent and 0x00FFFFFF) or ((fade * 245f).toInt().coerceIn(0, 255) shl 24)
            canvas.drawCircle(keyPulseX, keyPulseY, kr, rippleStrokePaint)
            if (keyPulseChar.isNotEmpty()) {
                val tw = cursorLabelPaint.measureText(keyPulseChar)
                canvas.drawText(keyPulseChar, keyPulseX - tw * 0.5f, keyPulseY - kr - 4f * dp, cursorLabelPaint)
            }
        }

        // 2c. Target inspection reticle ("checking" before clicking)
        if (checkActive) {
            val baseR = (if (isTabletDevice) 16f else 12f) * dp
            val pulseR = baseR * (1.30f - 0.30f * checkProgress)
            val alpha = ((0.88f - 0.36f * checkProgress) * 255).toInt().coerceIn(0, 255)
            rippleStrokePaint.color = (accent and 0x00FFFFFF) or (alpha shl 24)
            canvas.drawCircle(checkX, checkY, pulseR, rippleStrokePaint)
        }

        // 3. PC-matched radial-gradient expanding ripple (`scale 0.35 -> 3.6`)
        if (rippleActive) {
            val baseRadius = (if (isTabletDevice) 11f else 8.5f) * dp
            val scaleFactor = 0.35f + rippleProgress * 3.25f
            val r = baseRadius * scaleFactor
            val strokeAlpha = ((1f - rippleProgress) * 242).toInt().coerceIn(0, 255)
            val fillAlpha = ((1f - rippleProgress) * 72).toInt().coerceIn(0, 255)
            if (r > 1f) {
                rippleFillPaint.shader = RadialGradient(
                    rippleX, rippleY, r,
                    intArrayOf(
                        (accent and 0x00FFFFFF) or (fillAlpha shl 24),
                        (accent and 0x00FFFFFF) or ((fillAlpha / 5) shl 24)
                    ),
                    floatArrayOf(0f, 1f),
                    Shader.TileMode.CLAMP
                )
                canvas.drawCircle(rippleX, rippleY, r, rippleFillPaint)
                rippleFillPaint.shader = null
            }
            rippleStrokePaint.color = (accent and 0x00FFFFFF) or (strokeAlpha shl 24)
            canvas.drawCircle(rippleX, rippleY, r, rippleStrokePaint)
        }

        // 4. Moving PC-style Provider Cursor Arrow + Following Action/Typing Pill
        if (cursorVisible && cursorX >= 0f && cursorY >= 0f) {
            drawProviderCursor(canvas, cursorX, cursorY)
            if (!chromeHiddenForCapture) {
                drawFollowingCursorPill(canvas, cursorX, cursorY, w, h, accent)
            }
        }
    }

    private fun drawPcLayoutFrameAndCorners(canvas: Canvas, w: Float, h: Float, accent: Int) {
        val borderW = (if (isTabletDevice) 2.4f else 1.8f) * dp
        strokePaint.color = (accent and 0x00FFFFFF) or (0xC8 shl 24)
        strokePaint.strokeWidth = borderW
        val inset = borderW * 0.5f
        canvas.drawRect(inset, inset, w - inset, h - inset, strokePaint)

        // 4 crisp corner brackets matching .corner.tl/.tr/.bl/.br on PC
        val cLen = (if (isTabletDevice) 22f else 16f) * dp
        val pad = 3.5f * dp
        strokePaint.color = accent
        strokePaint.strokeWidth = (if (isTabletDevice) 3.0f else 2.4f) * dp
        // TL
        canvas.drawLine(pad, pad + cLen, pad, pad, strokePaint)
        canvas.drawLine(pad, pad, pad + cLen, pad, strokePaint)
        // TR
        canvas.drawLine(w - pad - cLen, pad, w - pad, pad, strokePaint)
        canvas.drawLine(w - pad, pad, w - pad, pad + cLen, strokePaint)
        // BL
        canvas.drawLine(pad, h - pad - cLen, pad, h - pad, strokePaint)
        canvas.drawLine(pad, h - pad, pad + cLen, h - pad, strokePaint)
        // BR
        canvas.drawLine(w - pad - cLen, h - pad, w - pad, h - pad, strokePaint)
        canvas.drawLine(w - pad, h - pad - cLen, w - pad, h - pad, strokePaint)
    }

    private fun drawTopControlBanner(canvas: Canvas, w: Float, accent: Int) {
        val msg = "Brief · ${provider.displayName} Active"
        val tw = bannerTextPaint.measureText(msg)
        val dotSpace = 13f * dp
        val padH = (if (isTabletDevice) 12f else 10f) * dp
        val pw = (tw + dotSpace + padH * 2f).coerceAtMost(w * 0.82f)
        val ph = (if (isTabletDevice) 24f else 20f) * dp
        val px = (w - pw) * 0.5f
        val cutoutTop = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            (rootWindowInsets?.displayCutout?.safeInsetTop ?: 0).toFloat()
        } else 0f
        val py = maxOf(cutoutTop + 10f * dp, (if (isTabletDevice) 36f else 48f) * dp)

        canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, pillBgPaint)
        strokePaint.color = (accent and 0x00FFFFFF) or (0xDC shl 24)
        strokePaint.strokeWidth = 1.3f * dp
        canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, strokePaint)

        fillPaint.color = accent
        canvas.drawCircle(px + padH + 3.5f * dp, py + ph * 0.5f, 3.3f * dp, fillPaint)
        canvas.drawText(msg, px + padH + dotSpace, py + ph * 0.69f, bannerTextPaint)
    }

    private fun drawFollowingCursorPill(canvas: Canvas, tipX: Float, tipY: Float, w: Float, h: Float, accent: Int) {
        val baseLabel = statusText.ifEmpty { "Working…" }.take(46)
        val isWatching = baseLabel.contains("👀") || baseLabel.contains("Watching", ignoreCase = true)
        val pillAccent = if (isWatching) 0xFF34D399.toInt() else accent
        val labelW = cursorLabelPaint.measureText(baseLabel)
        val typingStr = if (typingPreview.isNotEmpty()) "  $typingPreview" else ""
        val typingW = if (typingStr.isNotEmpty()) typingTextPaint.measureText(typingStr) else 0f

        val dotSpace = 11f * dp
        val padH = 9f * dp
        val pillW = (dotSpace + labelW + typingW + padH * 2f).coerceAtMost(w * 0.84f)
        val pillH = (if (isTabletDevice) 23f else 20f) * dp

        val offset = (if (isTabletDevice) 16f else 13f) * dp
        var px = tipX + offset
        var py = tipY + offset
        if (px + pillW > w - 8f * dp) {
            px = (tipX - pillW - 6f * dp).coerceAtLeast(6f * dp)
        }
        if (py + pillH > h - 28f * dp) {
            py = (tipY - pillH - 8f * dp).coerceAtLeast(8f * dp)
        }

        canvas.drawRoundRect(px, py, px + pillW, py + pillH, pillH / 2f, pillH / 2f, pillBgPaint)
        strokePaint.color = (pillAccent and 0x00FFFFFF) or (0xE8 shl 24)
        strokePaint.strokeWidth = (if (isWatching) 1.5f else 1.2f) * dp
        canvas.drawRoundRect(px, py, px + pillW, py + pillH, pillH / 2f, pillH / 2f, strokePaint)

        fillPaint.color = pillAccent
        canvas.drawCircle(px + padH + 3f * dp, py + pillH * 0.5f, 3f * dp, fillPaint)

        val textY = py + pillH * 0.69f
        val startX = px + padH + dotSpace
        canvas.save()
        canvas.clipRect(px + 2f, py, px + pillW - padH * 0.6f, py + pillH)
        canvas.drawText(baseLabel, startX, textY, cursorLabelPaint)
        if (typingStr.isNotEmpty()) {
            canvas.drawText(typingStr, startX + labelW, textY, typingTextPaint)
        }
        canvas.restore()
    }

    private fun drawProviderCursor(canvas: Canvas, tipX: Float, tipY: Float) {
        // Proportional scale: Phones smallest (22dp) -> Tablets medium (28dp) -> Desktop largest (30px+)
        val baseSizeDp = if (isTabletDevice) 28f else 22f
        val size = baseSizeDp * dp * clickScale
        val scale = size / 48f
        canvas.save()
        if (provider == ProviderId.OPENROUTER) {
            canvas.translate(tipX - 9.5f * scale, tipY - 5.5f * scale)
        } else {
            canvas.translate(tipX - 6f * scale, tipY - 6f * scale)
        }
        canvas.scale(scale, scale)

        when (provider) {
            ProviderId.GEMINI -> drawGeminiCursor(canvas)
            ProviderId.ANTHROPIC -> drawClaudeCursor(canvas)
            ProviderId.OPENAI -> drawOpenAiCursor(canvas)
            ProviderId.OPENROUTER -> drawOpenRouterCursor(canvas)
        }
        canvas.restore()
    }

    private fun drawGeminiCursor(canvas: Canvas) {
        val path = Path().apply {
            moveTo(9.5f, 8.0f)
            lineTo(38.5f, 20.5f)
            lineTo(24.5f, 24.5f)
            lineTo(20.0f, 39.5f)
            close()
        }
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 6.5f
        canvas.drawPath(path, strokePaint)

        fillPaint.shader = LinearGradient(
            9.5f, 8.0f, 38.5f, 24.0f,
            intArrayOf(0xFF2DD4E8.toInt(), 0xFF3882F8.toInt(), 0xFFA855F7.toInt()),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(path, fillPaint)
        fillPaint.shader = null

        val sp = Path().apply {
            val cx = 22.8f
            val cy = 21.8f
            val rx = 5.2f
            val ry = 5.6f
            moveTo(cx, cy - ry)
            quadTo(cx + rx * 0.25f, cy - ry * 0.25f, cx + rx, cy)
            quadTo(cx + rx * 0.25f, cy + ry * 0.25f, cx, cy + ry)
            quadTo(cx - rx * 0.25f, cy + ry * 0.25f, cx - rx, cy)
            quadTo(cx - rx * 0.25f, cy - ry * 0.25f, cx, cy - ry)
            close()
        }
        fillPaint.color = Color.WHITE
        canvas.drawPath(sp, fillPaint)
    }

    private fun drawClaudeCursor(canvas: Canvas) {
        val path = Path().apply {
            moveTo(6.0f, 7.5f)
            lineTo(42.5f, 7.5f)
            lineTo(23.5f, 42.5f)
            lineTo(22.0f, 22.0f)
            close()
        }
        strokePaint.color = 0xFFEE3A1A.toInt()
        strokePaint.strokeWidth = 2.6f
        canvas.drawPath(path, strokePaint)

        fillPaint.shader = LinearGradient(
            6.0f, 7.5f, 42.0f, 12.0f,
            intArrayOf(0xFFEE341A.toInt(), 0xFFF67016.toInt(), 0xFFF4AE18.toInt()),
            floatArrayOf(0f, 0.48f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(path, fillPaint)
        fillPaint.shader = null

        val cx = 28.2f
        val cy = 16.5f
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 1.3f
        canvas.drawLine(cx, 10.6f, cx, 22.4f, strokePaint)
        canvas.drawLine(22.3f, cy, 34.1f, cy, strokePaint)
        canvas.drawLine(24.0f, 12.3f, 32.4f, 20.7f, strokePaint)
        canvas.drawLine(32.4f, 12.3f, 24.0f, 20.7f, strokePaint)
        canvas.drawLine(25.6f, 10.9f, 30.8f, 22.1f, strokePaint)
        canvas.drawLine(22.7f, 13.9f, 33.7f, 19.1f, strokePaint)
        fillPaint.color = Color.WHITE
        canvas.drawCircle(cx, cy, 2.0f, fillPaint)
    }

    private fun drawOpenAiCursor(canvas: Canvas) {
        // Exact match to PC cursor-overlay.html: #6c9e95 sage triangle + 6 interlocking white circles
        val path = Path().apply {
            moveTo(6.0f, 6.0f)
            lineTo(42.0f, 17.0f)
            lineTo(17.0f, 42.0f)
            close()
        }
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 4.2f
        canvas.drawPath(path, strokePaint)

        fillPaint.color = 0xFF6C9E95.toInt()
        canvas.drawPath(path, fillPaint)

        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 1.4f
        val cx = 21.0f
        val cy = 21.0f
        val offsets = arrayOf(
            0f to -3.4f,
            2.95f to -1.7f,
            2.95f to 1.7f,
            0f to 3.4f,
            -2.95f to 1.7f,
            -2.95f to -1.7f
        )
        for ((ox, oy) in offsets) {
            canvas.drawCircle(cx + ox, cy + oy, 3.1f, strokePaint)
        }
    }

    private fun drawOpenRouterCursor(canvas: Canvas) {
        val path = Path().apply {
            moveTo(9.5f, 5.5f)
            lineTo(40.5f, 31.0f)
            lineTo(21.5f, 35.5f)
            lineTo(10.0f, 42.5f)
            close()
        }
        strokePaint.color = 0xB0DCE4F0.toInt()
        strokePaint.strokeWidth = 2.2f
        canvas.drawPath(path, strokePaint)

        fillPaint.color = 0xFF040406.toInt()
        canvas.drawPath(path, fillPaint)

        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 2.1f
        canvas.drawCircle(16.4f, 24.2f, 3.3f, strokePaint)

        val rPath = Path().apply {
            moveTo(21.0f, 27.6f)
            lineTo(21.0f, 20.8f)
            lineTo(23.4f, 20.8f)
            quadTo(25.5f, 20.8f, 25.5f, 22.6f)
            quadTo(25.5f, 24.4f, 23.2f, 24.4f)
            lineTo(21.4f, 24.4f)
            lineTo(25.4f, 27.6f)
        }
        canvas.drawPath(rPath, strokePaint)
    }
}
