package com.danonin.catempirecast

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.pedro.common.ConnectChecker
import com.pedro.library.rtmp.RtmpDisplay

/**
 * Serviço em primeiro plano que transmite a tela do celular (+ microfone)
 * via RTMP de verdade, usando a lib RootEncoder (MediaProjection + encoder
 * de vídeo/áudio embutido). É isso que faz o botão "📱" na chamada de voz
 * funcionar sem precisar de nenhum app externo (tipo Larix) — só dentro do
 * nosso próprio app Android.
 *
 * Fluxo:
 *  1. MainActivity pede a permissão de captura de tela (MediaProjectionManager)
 *  2. Com o resultCode/data da permissão, chama startBroadcast(...) aqui
 *  3. Esse serviço sobe em foreground (obrigatório desde o Android 10+ pra
 *     usar MediaProjection) e começa a publicar RTMP pras credenciais que
 *     vieram do backend (rtmpUrl + streamKey — ver server/media.js)
 *  4. Callbacks de conexão (sucesso/erro/desconexão) são repassados de volta
 *     pra MainActivity, que injeta window.onNativeBroadcastState(...) na
 *     página aberta no WebView.
 */
class BroadcastService : Service(), ConnectChecker {

    private val binder = LocalBinder()
    private var rtmpDisplay: RtmpDisplay? = null
    private var listener: BroadcastStateListener? = null

    inner class LocalBinder : Binder() {
        fun getService(): BroadcastService = this@BroadcastService
    }

    interface BroadcastStateListener {
        fun onState(state: String, message: String?)
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Cat Empire — transmissão ao vivo",
                NotificationManager.IMPORTANCE_LOW
            )
            manager.createNotificationChannel(channel)
        }
    }

    fun setListener(l: BroadcastStateListener?) {
        listener = l
    }

    /**
     * Inicia a transmissão. resultCode/data vêm do diálogo de permissão do
     * MediaProjection (ActivityResultContracts.StartActivityForResult
     * lançado a partir de MediaProjectionManager.createScreenCaptureIntent()).
     */
    fun startBroadcast(
        resultCode: Int,
        data: Intent,
        rtmpUrl: String,
        streamKey: String,
        quality: Int,
        fps: Int
    ) {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Cat Empire")
            .setContentText("Transmitindo sua tela ao vivo…")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        try {
            val display = RtmpDisplay(this, true, this)
            rtmpDisplay = display

            val profile = when (quality) {
                480 -> VideoProfile(480, 854, 1_500_000)
                1080 -> VideoProfile(1080, 1920, 5_000_000)
                else -> VideoProfile(720, 1280, 3_000_000)
            }
            val safeFps = if (fps in setOf(24, 30, 60)) fps else 30
            val prepared = display.prepareVideo(
                profile.width,
                profile.height,
                safeFps,
                profile.bitrate,
                2,
                0
            ) &&
                display.prepareAudio(128_000, 44100, true)

            if (!prepared) {
                listener?.onState("error", "Não foi possível preparar a captura de tela/áudio.")
                stopSelfCleanly()
                return
            }

            display.setIntentResult(resultCode, data)
            val endpoint = rtmpUrl.trimEnd('/') + "/" + streamKey
            display.startStream(endpoint)
        } catch (e: Exception) {
            listener?.onState("error", "Erro ao iniciar transmissão: ${e.message}")
            stopSelfCleanly()
        }
    }

    fun stopBroadcast() {
        try {
            rtmpDisplay?.let { if (it.isStreaming) it.stopStream() }
        } catch (e: Exception) {
            // já parado / estado inconsistente — ignora, só finaliza o serviço
        }
        rtmpDisplay = null
        listener?.onState("stopped", null)
        stopSelfCleanly()
    }

    private fun stopSelfCleanly() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        try { rtmpDisplay?.let { if (it.isStreaming) it.stopStream() } } catch (e: Exception) {}
        rtmpDisplay = null
        super.onDestroy()
    }

    // ========== ConnectChecker (callbacks do RootEncoder) ==========
    override fun onConnectionStarted(url: String) {}

    override fun onConnectionSuccess() {
        listener?.onState("started", null)
    }

    override fun onConnectionFailed(reason: String) {
        listener?.onState("error", reason)
        stopBroadcast()
    }

    override fun onNewBitrate(bitrate: Long) {}

    override fun onDisconnect() {
        listener?.onState("stopped", null)
    }

    override fun onAuthError() {
        listener?.onState("error", "Erro de autenticação RTMP.")
        stopBroadcast()
    }

    override fun onAuthSuccess() {}

    companion object {
        private const val CHANNEL_ID = "cat_empire_broadcast"
        private const val NOTIFICATION_ID = 4202

        fun intent(context: Context): Intent = Intent(context, BroadcastService::class.java)
    }

    private data class VideoProfile(val width: Int, val height: Int, val bitrate: Int)
}
