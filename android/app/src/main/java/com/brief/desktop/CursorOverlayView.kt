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
 * PC-Grade Hardware-Accelerated Provider Cursor Overlay for Android Phones & Tablets.
 *
 * - Device-proportional scale: Phones (smallest: 21dp) -> Tablets (medium: 28dp) -> PC (full desktop).
 * - Driven by `Choreographer` nanosecond VSYNC callbacks (smooth up to 120Hz / 144Hz / 150fps+
 *   even when Battery Saver disables ValueAnimator).
 * - Smooth human-like curved S-glide at custom speed, visible target-check reticle before clicking,
 *   pointer press-down bounce animation, and dual concentric click ripples.
 */
class CursorOverlayView(context: Context) : View(context) {
    private var provider: ProviderId = ProviderId.GEMINI
    private val isTabletDevice: Boolean = OemCompatibilityHelper.isTablet(context)

    private var cursorX: Float = -1f
    private var cursorY: Float = -1f
    private var cursorVisible: Boolean = false
    private var statusBadgeVisible: Boolean = true
    private var statusText: String = "Ready"

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

    // Target inspection / "checking" reticle state
    private var checkX: Float = 0f
    private var checkY: Float = 0f
    private var checkStartMs: Long = 0L
    private var checkDurationMs: Long = 220L
    private var checkProgress: Float = 0f
    private var checkActive: Boolean = false

    // Click press bounce + dual ripple state
    private var rippleX: Float = 0f
    private var rippleY: Float = 0f
    private var rippleStartMs: Long = 0L
    private var rippleDurationMs: Long = 420L
    private var rippleProgress: Float = 1f
    private var rippleActive: Boolean = false
    private var clickScale: Float = 1f

    private var vsyncScheduled: Boolean = false
    private val dp = resources.displayMetrics.density

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = (if (isTabletDevice) 2.4f else 1.9f) * dp
    }
    private val pillBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xE80A0D16.toInt()
    }
    private val pillTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = (if (isTabletDevice) 11.2f else 9.8f) * dp
        typeface = Typeface.DEFAULT_BOLD
    }

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            vsyncScheduled = false
            val now = SystemClock.uptimeMillis()
            var keepRunning = false

            if (moveAnimating) {
                val rawT = ((now - moveStartMs).toFloat() / moveDurationMs.toFloat()).coerceIn(0f, 1f)
                // Quintic smoothstep (smooth acceleration + gentle PC-style deceleration onto target)
                val t = rawT * rawT * rawT * (rawT * (rawT * 6f - 15f) + 10f)
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
                if (rawC >= 1f) {
                    checkActive = false
                } else {
                    keepRunning = true
                }
            }

            if (rippleActive) {
                val rawR = ((now - rippleStartMs).toFloat() / rippleDurationMs.toFloat()).coerceIn(0f, 1f)
                rippleProgress = 1f - (1f - rawR).pow(2.4f)
                // Pointer press-down bounce (1.0 -> 0.82 -> 1.05 -> 1.0)
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

            invalidate()
            if (keepRunning) {
                scheduleVsync()
            }
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
        statusText = status.take(44)
        if (!cursorVisible) {
            val dm = resources.displayMetrics
            cursorX = dm.widthPixels * 0.5f
            cursorY = dm.heightPixels * 0.52f
            cursorVisible = true
        }
        invalidate()
    }

    fun setBadgeHiddenForCapture(hidden: Boolean) {
        statusBadgeVisible = !hidden
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

        // Subtle natural arc perpendicular to travel vector (PC mouse feel)
        val dx = tx - moveStartX
        val dy = ty - moveStartY
        val dist = hypot(dx, dy)
        val midX = (moveStartX + tx) * 0.5f
        val midY = (moveStartY + ty) * 0.5f
        if (dist > 18f * dp) {
            val angle = atan2(dy, dx) + (Math.PI / 2.0).toFloat()
            val arc = (dist * 0.11f).coerceAtMost(28f * dp)
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

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val accent = when (provider) {
            ProviderId.GEMINI -> 0xFF3B82F6.toInt()
            ProviderId.OPENAI -> 0xFF2CB79F.toInt()
            ProviderId.ANTHROPIC -> 0xFFF97316.toInt()
            ProviderId.OPENROUTER -> 0xFF818CF8.toInt()
        }

        // Top-center compact live HUD pill (keeps top-left Back & top-right Search completely clear!)
        if (statusBadgeVisible) {
            val msg = "${provider.displayName} · $statusText"
            val tw = pillTextPaint.measureText(msg)
            val padH = (if (isTabletDevice) 11f else 9f) * dp
            val pw = (tw + padH * 2f).coerceAtMost(w * 0.78f)
            val ph = (if (isTabletDevice) 24f else 20.5f) * dp
            val px = ((w - pw) * 0.5f).coerceAtLeast(8f * dp)
            val py = (if (isTabletDevice) 30f else 34f) * dp
            canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, pillBgPaint)
            strokePaint.color = accent
            strokePaint.strokeWidth = 1.2f * dp
            canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, strokePaint)
            canvas.drawText(msg, px + padH, py + ph * 0.69f, pillTextPaint)
        }

        // Target inspection reticle ("checking" before clicking)
        if (checkActive) {
            val baseR = (if (isTabletDevice) 16f else 12f) * dp
            val pulseR = baseR * (1.28f - 0.28f * checkProgress)
            val alpha = ((0.85f - 0.35f * checkProgress) * 255).toInt().coerceIn(0, 255)
            ripplePaint.color = (accent and 0x00FFFFFF) or (alpha shl 24)
            canvas.drawCircle(checkX, checkY, pulseR, ripplePaint)
        }

        // Dual concentric click ripple
        if (rippleActive) {
            val maxR = (if (isTabletDevice) 26f else 19f) * dp
            val r1 = (5f * dp) + rippleProgress * maxR
            val a1 = ((1f - rippleProgress) * 235).toInt().coerceIn(0, 255)
            ripplePaint.color = (accent and 0x00FFFFFF) or (a1 shl 24)
            canvas.drawCircle(rippleX, rippleY, r1, ripplePaint)

            if (rippleProgress > 0.14f) {
                val p2 = ((rippleProgress - 0.14f) / 0.86f).coerceIn(0f, 1f)
                val r2 = (3f * dp) + p2 * (maxR * 0.68f)
                val a2 = ((1f - p2) * 175).toInt().coerceIn(0, 255)
                ripplePaint.color = (0x00FFFFFF) or (a2 shl 24)
                canvas.drawCircle(rippleX, rippleY, r2, ripplePaint)
            }
        }

        if (cursorVisible && cursorX >= 0f && cursorY >= 0f) {
            drawProviderCursor(canvas, cursorX, cursorY)
        }
    }

    private fun drawProviderCursor(canvas: Canvas, tipX: Float, tipY: Float) {
        // Proportional scale: Phones smallest (21dp) -> Tablets medium (28dp) -> Desktop largest
        val baseSizeDp = if (isTabletDevice) 28f else 21f
        val size = baseSizeDp * dp * clickScale
        val scale = size / 48f
        canvas.save()
        if (provider == ProviderId.OPENROUTER) {
            canvas.translate(tipX - 41f * scale, tipY - 31f * scale)
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
        strokePaint.color = Color.argb(140, 178, 198, 242)
        strokePaint.strokeWidth = 8.4f
        canvas.drawPath(path, strokePaint)

        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 7.2f
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
        strokePaint.color = 0xFFEE3E18.toInt()
        strokePaint.strokeWidth = 2.6f
        canvas.drawPath(path, strokePaint)

        fillPaint.shader = LinearGradient(
            6.0f, 7.5f, 40.0f, 12.0f,
            intArrayOf(0xFFEE341A.toInt(), 0xFFF67016.toInt(), 0xFFF4AE18.toInt()),
            floatArrayOf(0f, 0.46f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(path, fillPaint)
        fillPaint.shader = null

        val angles = doubleArrayOf(-95.0, -66.0, -38.0, -12.0, 12.0, 36.0, 62.0, 88.0, 120.0, 152.0, 184.0, 218.0, 248.0)
        val lens = doubleArrayOf(0.88, 1.00, 0.78, 0.96, 0.76, 0.94, 0.78, 1.00, 0.76, 0.94, 0.78, 0.92, 0.74)
        val cx = 28.2f
        val cy = 16.5f
        val rad = 6.2f
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 1.25f
        for (i in angles.indices) {
            val a = Math.toRadians(angles[i])
            val r2 = (rad * lens[i]).toFloat()
            canvas.drawLine(cx, cy, cx + (cos(a) * r2).toFloat(), cy + (sin(a) * r2).toFloat(), strokePaint)
        }
        fillPaint.color = Color.WHITE
        canvas.drawCircle(cx, cy, rad * 0.30f, fillPaint)
    }

    private fun drawOpenAiCursor(canvas: Canvas) {
        val path = Path().apply {
            moveTo(7.5f, 6.5f)
            lineTo(39.0f, 21.0f)
            lineTo(24.0f, 26.5f)
            lineTo(18.5f, 41.0f)
            close()
        }
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 5.0f
        canvas.drawPath(path, strokePaint)

        fillPaint.shader = LinearGradient(
            7.5f, 6.5f, 38.0f, 38.0f,
            0xFF2CB79F.toInt(),
            0xFF147E6D.toInt(),
            Shader.TileMode.CLAMP
        )
        canvas.drawPath(path, fillPaint)
        fillPaint.shader = null

        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 1.6f
        val cx = 22.0f
        val cy = 21.0f
        val r = 5.2f
        for (k in 0 until 6) {
            val a1 = Math.toRadians(k * 60.0)
            val a2 = Math.toRadians(k * 60.0 + 75.0)
            canvas.drawLine(
                cx + (cos(a1) * r * 0.45f).toFloat(),
                cy + (sin(a1) * r * 0.45f).toFloat(),
                cx + (cos(a2) * r).toFloat(),
                cy + (sin(a2) * r).toFloat(),
                strokePaint
            )
        }
    }

    private fun drawOpenRouterCursor(canvas: Canvas) {
        val path = Path().apply {
            moveTo(6.5f, 5.5f)
            lineTo(41.5f, 31.2f)
            lineTo(24.0f, 35.0f)
            lineTo(8.5f, 43.5f)
            close()
        }
        strokePaint.color = 0x55FFFFFF
        strokePaint.strokeWidth = 2.6f
        canvas.drawPath(path, strokePaint)

        fillPaint.color = 0xFF050507.toInt()
        canvas.drawPath(path, fillPaint)

        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 2.6f
        canvas.drawCircle(16.2f, 25.0f, 4.6f, strokePaint)

        val rPath = Path().apply {
            moveTo(21.5f, 29.6f)
            lineTo(21.5f, 20.5f)
            lineTo(25.8f, 20.5f)
            quadTo(29.0f, 20.5f, 29.0f, 23.2f)
            quadTo(29.0f, 25.6f, 25.6f, 25.8f)
            lineTo(21.8f, 25.8f)
            moveTo(25.2f, 25.8f)
            lineTo(29.6f, 29.6f)
        }
        canvas.drawPath(rPath, strokePaint)
    }
}
