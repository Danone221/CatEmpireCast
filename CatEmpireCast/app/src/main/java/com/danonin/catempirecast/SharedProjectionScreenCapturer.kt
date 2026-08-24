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
    private var disposed = false

    override fun initialize(
        surfaceTextureHelper: SurfaceTextureHelper,
        applicationContext: android.content.Context,
        capturerObserver: CapturerObserver
    ) {
        check(!disposed) { "Capturador já descartado" }
        textureHelper = surfaceTextureHelper
        observer = capturerObserver
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        check(!disposed) { "Capturador já descartado" }
        val helper = requireNotNull(textureHelper) { "Capturador não inicializado" }
        this.width = width
        this.height = height
        helper.setTextureSize(width, height)
        projection.registerCallback(projectionCallback, helper.handler)
        surface = Surface(helper.surfaceTexture)
        display = projection.createVirtualDisplay(
            "CatEmpireScreenCapture",
            width,
            height,
            400,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION,
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
        val helper = textureHelper ?: return
        helper.setTextureSize(width, height)
        display?.resize(width, height, 400)
        surface?.release()
        surface = Surface(helper.surfaceTexture)
        display?.setSurface(surface)
    }

    override fun dispose() {
        disposed = true
    }

    override fun isScreencast(): Boolean = true

    override fun onFrame(frame: VideoFrame) {
        observer?.onFrameCaptured(frame)
    }
}
