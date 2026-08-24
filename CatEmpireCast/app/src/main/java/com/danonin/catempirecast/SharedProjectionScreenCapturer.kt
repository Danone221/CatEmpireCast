package com.danonin.catempirecast

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

/** Captura vídeo usando o mesmo MediaProjection usado pelo áudio interno. */
class SharedProjectionScreenCapturer(
    private val projection: MediaProjection,
    private val projectionCallback: MediaProjection.Callback
) : VideoCapturer, VideoSink {
    private var textureHelper: SurfaceTextureHelper? = null
    private var observer: CapturerObserver? = null
    private var display: VirtualDisplay? = null
    private var surface: Surface? = null
    private var width = 0
    private var height = 0
    private var densityDpi = 320
    @Volatile private var targetFps = 30
    private var nextFrameAtNs = 0L
    private var disposed = false

    override fun initialize(
        surfaceTextureHelper: SurfaceTextureHelper,
        applicationContext: android.content.Context,
        capturerObserver: CapturerObserver
    ) {
        check(!disposed) { "Capturador já descartado" }
        textureHelper = surfaceTextureHelper
        observer = capturerObserver
        densityDpi = applicationContext.resources.displayMetrics.densityDpi.coerceAtLeast(160)
        surfaceTextureHelper.handler.post {
            try {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_DISPLAY)
            } catch (_: Exception) {}
        }
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        check(!disposed) { "Capturador já descartado" }
        val helper = requireNotNull(textureHelper) { "Capturador não inicializado" }
        this.width = width
        this.height = height
        targetFps = framerate.coerceIn(1, 60)
        nextFrameAtNs = 0L
        helper.setTextureSize(width, height)
        projection.registerCallback(projectionCallback, helper.handler)
        surface = Surface(helper.surfaceTexture)
        display = projection.createVirtualDisplay(
            "CatEmpireScreenCapture",
            width,
            height,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface,
            null,
            null
        )
        observer?.onCapturerStarted(display != null)
        helper.startListening(this)
    }

    override fun stopCapture() {
        val helper = textureHelper
        helper?.stopListening()
        display?.release()
        display = null
        surface?.release()
        surface = null
        try { projection.unregisterCallback(projectionCallback) } catch (_: Exception) {}
        observer?.onCapturerStopped()
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        this.width = width
        this.height = height
        targetFps = framerate.coerceIn(1, 60)
        nextFrameAtNs = 0L
        val helper = textureHelper ?: return
        helper.setTextureSize(width, height)
        display?.resize(width, height, densityDpi)
        surface?.release()
        surface = Surface(helper.surfaceTexture)
        display?.setSurface(surface)
    }

    override fun dispose() {
        disposed = true
    }

    override fun isScreencast(): Boolean = true

    override fun onFrame(frame: VideoFrame) {
        // MediaProjection entrega na taxa física do aparelho (com frequência
        // 60/90/120 Hz). Sem limitar aqui, a opção de FPS era apenas visual e
        // cada encoder WebRTC tentava processar quadros desnecessários.
        val now = System.nanoTime()
        val frameIntervalNs = 1_000_000_000L / targetFps.coerceAtLeast(1)
        if (nextFrameAtNs == 0L) {
            nextFrameAtNs = now + frameIntervalNs
        } else {
            // Aceita o quadro físico ligeiramente adiantado. Sem tolerância,
            // uma tela de 60 Hz podia entregar 33,2 ms em vez de 33,3 ms e o
            // limitador descartava esse quadro, fazendo 30 FPS virar ~20 FPS.
            if (now + FRAME_EARLY_TOLERANCE_NS < nextFrameAtNs) return
            do {
                nextFrameAtNs += frameIntervalNs
            } while (nextFrameAtNs <= now)
        }
        observer?.onFrameCaptured(frame)
    }

    companion object {
        private const val FRAME_EARLY_TOLERANCE_NS = 2_000_000L
    }
}
