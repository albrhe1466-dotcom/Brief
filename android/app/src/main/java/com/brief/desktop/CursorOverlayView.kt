package com.brief.desktop

import android.content.Context
import android.graphics.*
import android.os.SystemClock
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * Hardware-accelerated click-through Accessibility Overlay drawing Brief's 4 custom
 * provider cursors (Gemini sparkle arrow, Claude orange starburst chevron,
 * OpenAI sage-teal triangle, OpenRouter black OR triangle) with ZERO gray border,
 * ZERO particles, and a real-time frame clock (`SystemClock.uptimeMillis` +
 * `postOnAnimation`) so cursor glide & click ripples stay silky smooth at 60-120fps
 * even when Samsung Power Saving / Reduce Animations disables ValueAnimator!
 */
class CursorOverlayView(context: Context) : View(context) {
    private var provider: ProviderId = ProviderId.GEMINI
    private var cursorX: Float = -200f
    private var cursorY: Float = -200f
    private var cursorVisible: Boolean = false
    private var statusText: String = "Brief"

    // Real-time cursor glide state (immune to ANIMATOR_DURATION_SCALE = 0 on Samsung battery saver)
    private var moveStartX: Float = 0f
    private var moveStartY: Float = 0f
    private var moveTargetX: Float = 0f
    private var moveTargetY: Float = 0f
    private var moveStartTime: Long = 0L
    private var moveDuration: Long = 220L
    private var moveAnimating: Boolean = false

    // Real-time click ripple state
    private var rippleX: Float = 0f
    private var rippleY: Float = 0f
    private var rippleStartTime: Long = 0L
    private var rippleDuration: Long = 380L
    private var rippleProgress: Float = 1f
    private var rippleActive: Boolean = false

    private var loopScheduled: Boolean = false

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
        strokeWidth = 2.5f * dp
    }
    private val pillBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xEB090C14.toInt()
    }
    private val pillTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 11.5f * dp
        typeface = Typeface.DEFAULT_BOLD
    }

    private val frameTick = object : Runnable {
        override fun run() {
            loopScheduled = false
            val now = SystemClock.uptimeMillis()
            var needsMoreFrames = false

            if (moveAnimating) {
                val rawT = ((now - moveStartTime).toFloat() / moveDuration.toFloat()).coerceIn(0f, 1f)
                val eased = 1f - (1f - rawT).pow(3)
                cursorX = moveStartX + (moveTargetX - moveStartX) * eased
                cursorY = moveStartY + (moveTargetY - moveStartY) * eased
                if (rawT >= 1f) {
                    moveAnimating = false
                } else {
                    needsMoreFrames = true
                }
            }

            if (rippleActive) {
                val rawR = ((now - rippleStartTime).toFloat() / rippleDuration.toFloat()).coerceIn(0f, 1f)
                rippleProgress = 1f - (1f - rawR).pow(2)
                if (rawR >= 1f) {
                    rippleActive = false
                } else {
                    needsMoreFrames = true
                }
            }

            invalidate()
            if (needsMoreFrames) {
                scheduleTick()
            }
        }
    }

    init {
        setLayerType(LAYER_TYPE_HARDWARE, null)
        setBackgroundColor(Color.TRANSPARENT)
    }

    private fun scheduleTick() {
        if (!loopScheduled) {
            loopScheduled = true
            postOnAnimation(frameTick)
        }
    }

    fun setState(p: ProviderId, status: String) {
        provider = p
        statusText = status.take(42)
        invalidate()
    }

    fun showCursorAt(x: Float, y: Float) {
        moveAnimating = false
        cursorX = x
        cursorY = y
        cursorVisible = true
        invalidate()
    }

    fun animateMoveTo(tx: Float, ty: Float, durationMs: Long = 220L) {
        if (!cursorVisible || cursorX < 0f || cursorY < 0f) {
            cursorX = tx
            cursorY = ty
            cursorVisible = true
            invalidate()
            return
        }
        moveStartX = cursorX
        moveStartY = cursorY
        moveTargetX = tx
        moveTargetY = ty
        moveStartTime = SystemClock.uptimeMillis()
        moveDuration = durationMs.coerceIn(70L, 520L)
        moveAnimating = true
        cursorVisible = true
        scheduleTick()
    }

    fun triggerRipple(x: Float, y: Float) {
        rippleX = x
        rippleY = y
        rippleStartTime = SystemClock.uptimeMillis()
        rippleProgress = 0f
        rippleActive = true
        scheduleTick()
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

        // Compact obsidian status pill at top-left (NO full-screen gray border!)
        val msg = "${provider.displayName} · $statusText"
        val tw = pillTextPaint.measureText(msg)
        val pw = tw + 24f * dp
        val ph = 26f * dp
        val px = 14f * dp
        val py = 36f * dp
        canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, pillBgPaint)
        strokePaint.color = accent
        strokePaint.strokeWidth = 1.4f * dp
        canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, strokePaint)
        canvas.drawText(msg, px + 12f * dp, py + 17.5f * dp, pillTextPaint)

        // Clean single click ripple (NO particles)
        if (rippleActive) {
            val r = (8f + rippleProgress * 30f) * dp
            val alpha = ((1f - rippleProgress) * 235).toInt().coerceIn(0, 255)
            ripplePaint.color = (accent and 0x00FFFFFF) or (alpha shl 24)
            canvas.drawCircle(rippleX, rippleY, r, ripplePaint)
        }

        if (cursorVisible) {
            drawProviderCursor(canvas, cursorX, cursorY)
        }
    }

    private fun drawProviderCursor(canvas: Canvas, tipX: Float, tipY: Float) {
        val size = 40f * dp
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

        // Bold white "OR" emblem inside triangle
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
