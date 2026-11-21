package com.brief.desktop

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.view.View
import android.view.animation.DecelerateInterpolator
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Click-through full-screen overlay drawing Brief's 4 custom provider cursors
 * (Gemini sparkle arrow, Claude orange starburst chevron, OpenAI sage-teal triangle,
 * OpenRouter black OR triangle) with ZERO particles and clean click ripples.
 */
class CursorOverlayView(context: Context) : View(context) {
    private var provider: ProviderId = ProviderId.GEMINI
    private var cursorX: Float = -200f
    private var cursorY: Float = -200f
    private var cursorVisible: Boolean = false
    private var statusText: String = "Brief"

    private var rippleX: Float = 0f
    private var rippleY: Float = 0f
    private var rippleProgress: Float = 1f
    private var rippleActive: Boolean = false

    private var moveAnim: ValueAnimator? = null
    private var rippleAnim: ValueAnimator? = null

    private val dp = resources.displayMetrics.density
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f * dp
    }
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
        color = 0xE60B0E17.toInt()
    }
    private val pillTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 11.5f * dp
        typeface = Typeface.DEFAULT_BOLD
    }

    fun setState(p: ProviderId, status: String) {
        provider = p
        statusText = status.take(42)
        invalidate()
    }

    fun showCursorAt(x: Float, y: Float) {
        cursorX = x
        cursorY = y
        cursorVisible = true
        invalidate()
    }

    fun animateMoveTo(tx: Float, ty: Float, durationMs: Long = 220L) {
        moveAnim?.cancel()
        if (!cursorVisible || cursorX < 0f || cursorY < 0f) {
            cursorX = tx
            cursorY = ty
            cursorVisible = true
            invalidate()
            return
        }
        val sx = cursorX
        val sy = cursorY
        moveAnim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = durationMs.coerceIn(60L, 480L)
            interpolator = DecelerateInterpolator()
            addUpdateListener { anim ->
                val t = anim.animatedValue as Float
                cursorX = sx + (tx - sx) * t
                cursorY = sy + (ty - sy) * t
                invalidate()
            }
            start()
        }
    }

    fun triggerRipple(x: Float, y: Float) {
        rippleAnim?.cancel()
        rippleX = x
        rippleY = y
        rippleActive = true
        rippleAnim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 380L
            interpolator = DecelerateInterpolator()
            addUpdateListener { anim ->
                rippleProgress = anim.animatedValue as Float
                if (rippleProgress >= 0.99f) rippleActive = false
                invalidate()
            }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val accent = when (provider) {
            ProviderId.GEMINI -> 0xFF3B82F6.toInt()
            ProviderId.OPENAI -> 0xFFFFFFFF.toInt()
            ProviderId.ANTHROPIC -> 0xFFF97316.toInt()
            ProviderId.OPENROUTER -> 0xFF818CF8.toInt()
        }
        borderPaint.color = (accent and 0x00FFFFFF) or 0xAA000000.toInt()
        canvas.drawRect(borderPaint.strokeWidth / 2f, borderPaint.strokeWidth / 2f, w - borderPaint.strokeWidth / 2f, h - borderPaint.strokeWidth / 2f, borderPaint)

        // Subtle status pill at top-left
        val msg = "${provider.displayName} · $statusText"
        val tw = pillTextPaint.measureText(msg)
        val pw = tw + 24f * dp
        val ph = 26f * dp
        val px = 14f * dp
        val py = 34f * dp
        canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, pillBgPaint)
        strokePaint.color = accent
        strokePaint.strokeWidth = 1.4f * dp
        canvas.drawRoundRect(px, py, px + pw, py + ph, ph / 2f, ph / 2f, strokePaint)
        canvas.drawText(msg, px + 12f * dp, py + 17.5f * dp, pillTextPaint)

        // Clean single click ripple (NO particles)
        if (rippleActive) {
            val r = (8f + rippleProgress * 30f) * dp
            val alpha = ((1f - rippleProgress) * 230).toInt().coerceIn(0, 255)
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
            moveTo(6f, 6f)
            lineTo(42f, 17f)
            lineTo(17f, 42f)
            close()
        }
        strokePaint.color = Color.argb(215, 255, 255, 255)
        strokePaint.strokeWidth = 7.2f
        canvas.drawPath(path, strokePaint)

        val teal = 0xFF6C9E95.toInt()
        strokePaint.color = teal
        strokePaint.strokeWidth = 5.0f
        canvas.drawPath(path, strokePaint)
        fillPaint.color = teal
        canvas.drawPath(path, fillPaint)

        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 1.45f
        for (i in 0 until 6) {
            val a = i * Math.PI / 3.0
            val ox = 20.5f + (cos(a) * 3.4).toFloat()
            val oy = 20.5f + (sin(a) * 3.4).toFloat()
            canvas.drawCircle(ox, oy, 3.1f, strokePaint)
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
        strokePaint.color = Color.argb(155, 220, 228, 240)
        strokePaint.strokeWidth = 4.2f
        canvas.drawPath(path, strokePaint)

        strokePaint.color = 0xFF040406.toInt()
        strokePaint.strokeWidth = 3.4f
        canvas.drawPath(path, strokePaint)
        fillPaint.color = 0xFF040406.toInt()
        canvas.drawPath(path, fillPaint)

        // Bold white "OR" monogram centered
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = 2.2f
        canvas.drawCircle(16.6f, 24.2f, 3.2f, strokePaint)
        val rPath = Path().apply {
            moveTo(20.9f, 27.6f)
            lineTo(20.9f, 20.8f)
            lineTo(23.5f, 20.8f)
            quadTo(25.8f, 20.8f, 25.8f, 22.6f)
            quadTo(25.8f, 24.4f, 23.4f, 24.4f)
            lineTo(21.3f, 24.4f)
            moveTo(22.2f, 24.4f)
            lineTo(25.7f, 27.6f)
        }
        canvas.drawPath(rPath, strokePaint)
    }
}
