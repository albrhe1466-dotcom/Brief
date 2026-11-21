package com.brief.desktop

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.delay
import java.io.ByteArrayOutputStream

class ScreenCaptureService : Service() {
    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        private const val CHANNEL_ID = "brief_screen_vision"
        private const val NOTIF_ID = 4103

        @Volatile
        var instance: ScreenCaptureService? = null
            private set

        fun isReady(): Boolean = instance?.projection != null
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var capHandler: Handler? = null
    private var capWidth = 0
    private var capHeight = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        ensureChannel()
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Brief Screen Vision Ready")
            .setContentText("Allows Brief to inspect screen screenshots cleanly")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val code = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        if (code == Activity.RESULT_OK && data != null) {
            setupProjection(code, data)
        }
        return START_NOT_STICKY
    }

    private fun setupProjection(resultCode: Int, data: Intent) {
        teardownProjection()
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = mgr.getMediaProjection(resultCode, data) ?: return
        projection = mp

        val thread = HandlerThread("BriefCaptureThread").apply { start() }
        handlerThread = thread
        val h = Handler(thread.looper)
        capHandler = h

        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                teardownProjection()
            }
        }, h)

        val (rawW, rawH) = DisplayUtils.getRealScreenSize(this)
        val maxEdge = maxOf(rawW, rawH).coerceAtLeast(1)
        val scale = if (maxEdge > 1080) 1080f / maxEdge.toFloat() else 1f
        capWidth = (rawW * scale).toInt().coerceAtLeast(240)
        capHeight = (rawH * scale).toInt().coerceAtLeast(240)

        val reader = ImageReader.newInstance(capWidth, capHeight, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        val density = resources.displayMetrics.densityDpi
        virtualDisplay = mp.createVirtualDisplay(
            "BriefPhoneVision",
            capWidth,
            capHeight,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            h
        )
    }

    suspend fun captureJpegBase64(): String? {
        val reader = imageReader ?: return null
        CursorOverlayService.instance?.setTemporarilyHidden(true)
        delay(60L)
        return try {
            var img = reader.acquireLatestImage()
            if (img == null) {
                delay(90L)
                img = reader.acquireLatestImage()
            }
            if (img == null) return null
            try {
                val plane = img.planes[0]
                val buffer = plane.buffer
                val pixelStride = plane.pixelStride
                val rowStride = plane.rowStride
                val rowPadding = rowStride - pixelStride * capWidth
                val rawBitmap = Bitmap.createBitmap(
                    capWidth + rowPadding / pixelStride,
                    capHeight,
                    Bitmap.Config.ARGB_8888
                )
                rawBitmap.copyPixelsFromBuffer(buffer)
                val cropped = if (rawBitmap.width != capWidth) {
                    Bitmap.createBitmap(rawBitmap, 0, 0, capWidth, capHeight).also { rawBitmap.recycle() }
                } else {
                    rawBitmap
                }
                val baos = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 82, baos)
                cropped.recycle()
                Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
            } finally {
                try { img.close() } catch (_: Exception) {}
            }
        } catch (_: Exception) {
            null
        } finally {
            CursorOverlayService.instance?.setTemporarilyHidden(false)
        }
    }

    private fun teardownProjection() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        try { imageReader?.close() } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        try { handlerThread?.quitSafely() } catch (_: Exception) {}
        virtualDisplay = null
        imageReader = null
        projection = null
        handlerThread = null
        capHandler = null
    }

    override fun onDestroy() {
        teardownProjection()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Brief Screen Capture", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
    }
}
