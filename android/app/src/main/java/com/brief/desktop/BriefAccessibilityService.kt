package com.brief.desktop

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

class BriefAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: BriefAccessibilityService? = null
            private set

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

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
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

        CursorOverlayService.instance?.moveTo(px, py, 200L)
        delay(190L)
        CursorOverlayService.instance?.rippleAt(px, py)

        val p = Path().apply { moveTo(px, py) }
        return dispatchPath(p, if (longPress) 700L else 55L)
    }

    suspend fun doubleTapNormalized(nx: Double, ny: Double): Boolean {
        val ok1 = tapNormalized(nx, ny, false)
        delay(85L)
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val px = DisplayUtils.normToPx(nx, w).coerceIn(4f, (w - 4).toFloat())
        val py = DisplayUtils.normToPx(ny, h).coerceIn(4f, (h - 4).toFloat())
        CursorOverlayService.instance?.rippleAt(px, py)
        val ok2 = dispatchPath(Path().apply { moveTo(px, py) }, 50L)
        return ok1 && ok2
    }

    suspend fun swipeNormalized(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Long = 340L): Boolean {
        val (w, h) = DisplayUtils.getRealScreenSize(this)
        val sx = DisplayUtils.normToPx(x1, w).coerceIn(6f, (w - 6).toFloat())
        val sy = DisplayUtils.normToPx(y1, h).coerceIn(6f, (h - 6).toFloat())
        val ex = DisplayUtils.normToPx(x2, w).coerceIn(6f, (w - 6).toFloat())
        val ey = DisplayUtils.normToPx(y2, h).coerceIn(6f, (h - 6).toFloat())

        CursorOverlayService.instance?.moveTo(sx, sy, 150L)
        delay(140L)
        CursorOverlayService.instance?.moveTo(ex, ey, durationMs.coerceIn(140L, 900L))

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
