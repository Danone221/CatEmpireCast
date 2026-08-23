package com.danonin.catempirecast

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import org.webrtc.*
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Captura MediaProjection e publica a tela no mesh WebRTC do canal. */
class BroadcastService : Service() {
    private val binder = LocalBinder()
    private var listener: BroadcastStateListener? = null
    private var socket: Socket? = null
    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var capturer: VideoCapturer? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private val peers = ConcurrentHashMap<String, PeerConnection>()
    private var profileLabel = ""
    private var broadcastBitrateBps = 2_500_000
    private var broadcastFps = 30
    private val rtcExecutor = Executors.newSingleThreadExecutor()
    private val stopping = AtomicBoolean(false)

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
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Cat Empire — transmissão ao vivo", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    fun setListener(value: BroadcastStateListener?) { listener = value }

    fun startBroadcast(
        resultCode: Int,
        projectionData: Intent,
        baseUrl: String,
        token: String,
        userId: String,
        channelId: String,
        quality: Int,
        fps: Int
    ) {
        if (socket != null || stopping.get()) return
        stopping.set(false)
        startProjectionForeground()
        rtcExecutor.execute { try {
            val base = when (quality) {
                480 -> Triple(854, 480, "480p")
                1080 -> Triple(1920, 1080, "1080p")
                else -> Triple(1280, 720, "720p")
            }
            val portrait = resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
            val width = if (portrait) base.second else base.first
            val height = if (portrait) base.first else base.second
            val safeFps = if (fps in setOf(24, 30, 60)) fps else 30
            broadcastFps = safeFps
            broadcastBitrateBps = when (quality) {
                480 -> 1_200_000
                1080 -> 5_000_000
                else -> 2_500_000
            }
            profileLabel = "${base.third} · $safeFps FPS"

            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
            )
            eglBase = EglBase.create()
            val context = eglBase!!.eglBaseContext
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(context, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(context))
                .createPeerConnectionFactory()

            capturer = ScreenCapturerAndroid(
                projectionData,
                object : android.media.projection.MediaProjection.Callback() {
                    override fun onStop() { stopBroadcast() }
                }
            )
            source = factory!!.createVideoSource(true)
            textureHelper = SurfaceTextureHelper.create("CatEmpireScreen", context)
            capturer!!.initialize(textureHelper, applicationContext, source!!.capturerObserver)
            capturer!!.startCapture(width, height, safeFps)
            track = factory!!.createVideoTrack("cat-native-screen", source)
            connectSignaling(baseUrl, token, userId, channelId)
        } catch (error: Exception) {
            listener?.onState("error", "Erro ao preparar WebRTC: ${error.message}")
            stopBroadcast()
        } }
    }

    private fun connectSignaling(baseUrl: String, token: String, userId: String, channelId: String) {
        val options = IO.Options.builder()
            .setReconnection(true)
            .setReconnectionAttempts(Int.MAX_VALUE)
            .setReconnectionDelay(1_000)
            .setTimeout(15_000)
            .build()
        val client = IO.socket(URI(baseUrl), options)
        socket = client
        client.on(Socket.EVENT_CONNECT) {
            client.emit("register-native-screen", JSONObject()
                .put("token", token).put("userId", userId).put("channelId", channelId))
        }
        client.on("native-screen-registered") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val viewers = payload.optJSONArray("viewers") ?: return@on
            rtcExecutor.execute {
                peers.values.forEach { it.close() }
                peers.clear()
                for (index in 0 until viewers.length()) {
                    viewers.optString(index).takeIf { it.isNotBlank() }?.let(::createOfferFor)
                }
                listener?.onState("started", profileLabel)
            }
        }
        client.on("native-screen-viewer-joined") { args ->
            val id = (args.firstOrNull() as? JSONObject)?.optString("userId").orEmpty()
            if (id.isNotBlank()) rtcExecutor.execute { createOfferFor(id) }
        }
        client.on("native-screen-viewer-left") { args ->
            val id = (args.firstOrNull() as? JSONObject)?.optString("userId").orEmpty()
            if (id.isNotBlank()) rtcExecutor.execute { peers.remove(id)?.close() }
        }
        client.on("voice-signal") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val from = payload.optString("from")
            val data = payload.optJSONObject("data")
            if (from.isNotBlank() && data != null) rtcExecutor.execute { handleSignal(from, data) }
        }
        client.on("native-screen-error") { args ->
            val message = (args.firstOrNull() as? JSONObject)?.optString("message")
            listener?.onState("error", message ?: "Falha na sinalização da tela.")
            stopBroadcast()
        }
        client.on(Socket.EVENT_CONNECT_ERROR) {
            listener?.onState("error", "Não foi possível conectar a transmissão ao canal.")
        }
        client.connect()
    }

    private fun createOfferFor(viewerId: String) {
        if (peers.containsKey(viewerId)) return
        val rtcConfig = PeerConnection.RTCConfiguration(listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        )).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val pc = factory?.createPeerConnection(rtcConfig, peerObserver(viewerId)) ?: return
        peers[viewerId] = pc
        val sender = pc.addTrack(track ?: return, listOf("cat-native-screen"))
        val parameters = sender.parameters
        parameters.encodings.forEach { encoding ->
            encoding.maxBitrateBps = broadcastBitrateBps
            encoding.maxFramerate = broadcastFps
        }
        sender.parameters = parameters
        pc.createOffer(object : BasicSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription?) {
                if (description == null) return
                pc.setLocalDescription(object : BasicSdpObserver() {
                    override fun onSetSuccess() {
                        emitSignal(viewerId, JSONObject().put("sdp", JSONObject()
                            .put("type", description.type.canonicalForm())
                            .put("sdp", description.description)))
                    }
                }, description)
            }
        }, MediaConstraints())
    }

    private fun handleSignal(from: String, data: JSONObject) {
        val pc = peers[from] ?: return
        data.optJSONObject("sdp")?.let { sdp ->
            val type = if (sdp.optString("type") == "answer") SessionDescription.Type.ANSWER else SessionDescription.Type.OFFER
            pc.setRemoteDescription(BasicSdpObserver(), SessionDescription(type, sdp.optString("sdp")))
            return
        }
        data.optJSONObject("candidate")?.let { candidate ->
            pc.addIceCandidate(IceCandidate(
                candidate.optString("sdpMid").ifBlank { null },
                candidate.optInt("sdpMLineIndex", 0),
                candidate.optString("candidate")
            ))
        }
    }

    private fun peerObserver(viewerId: String) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            if (state == PeerConnection.IceConnectionState.FAILED || state == PeerConnection.IceConnectionState.CLOSED) {
                rtcExecutor.execute { peers.remove(viewerId)?.close() }
            }
        }
        override fun onIceConnectionReceivingChange(value: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(candidate: IceCandidate?) {
            if (candidate == null) return
            emitSignal(viewerId, JSONObject().put("candidate", JSONObject()
                .put("candidate", candidate.sdp)
                .put("sdpMid", candidate.sdpMid)
                .put("sdpMLineIndex", candidate.sdpMLineIndex)))
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
    }

    private fun emitSignal(to: String, data: JSONObject) {
        socket?.emit("native-screen-signal", JSONObject().put("to", to).put("data", data))
    }

    fun stopBroadcast() {
        if (!stopping.compareAndSet(false, true)) return
        rtcExecutor.execute { releaseBroadcast() }
    }

    private fun releaseBroadcast() {
        peers.values.forEach { it.close() }
        peers.clear()
        socket?.disconnect()
        socket = null
        try { capturer?.stopCapture() } catch (_: Exception) {}
        capturer?.dispose(); capturer = null
        track?.dispose(); track = null
        source?.dispose(); source = null
        textureHelper?.dispose(); textureHelper = null
        factory?.dispose(); factory = null
        eglBase?.release(); eglBase = null
        Handler(Looper.getMainLooper()).post {
            listener?.onState("stopped", null)
            stopSelfCleanly()
        }
    }

    private fun startProjectionForeground() {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Cat Empire")
            .setContentText("Transmitindo sua tela no canal…")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopSelfCleanly() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        if (!stopping.get()) stopBroadcast()
        rtcExecutor.shutdown()
        super.onDestroy()
    }

    private open class BasicSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(message: String?) {}
        override fun onSetFailure(message: String?) {}
    }

    companion object {
        private const val CHANNEL_ID = "cat_empire_broadcast"
        private const val NOTIFICATION_ID = 4202
        fun intent(context: Context): Intent = Intent(context, BroadcastService::class.java)
    }
}
