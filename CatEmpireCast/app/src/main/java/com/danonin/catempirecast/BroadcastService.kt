package com.danonin.catempirecast

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Base64
import androidx.core.app.NotificationCompat
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import org.webrtc.*
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

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
    private var mediaProjection: MediaProjection? = null
    private var playbackAudioRecord: AudioRecord? = null
    private var playbackAudioThread: Thread? = null
    private var diagnosticSink: VideoSink? = null
    private val peers = ConcurrentHashMap<String, PeerConnection>()
    private val pendingCandidates = ConcurrentHashMap<String, MutableList<IceCandidate>>()
    private var profileLabel = ""
    private var broadcastBitrateBps = 2_500_000
    private var broadcastFps = 30
    private val rtcExecutor = Executors.newSingleThreadExecutor()
    private val stopping = AtomicBoolean(false)
    private val playbackAudioRunning = AtomicBoolean(false)
    private val playbackAudioSequence = AtomicLong(0)
    private val firstFrameReported = AtomicBoolean(false)
    @Volatile private var firstFrameDetail: String? = null
    private var screenAudioAllowed = false

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
        screenAudioAllowed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        firstFrameReported.set(false)
        firstFrameDetail = null
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

            val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = projectionManager.getMediaProjection(resultCode, projectionData)
                ?: throw IllegalStateException("O Android não criou a captura de tela")
            val projectionCallback = object : MediaProjection.Callback() {
                override fun onStop() { stopBroadcast() }
            }
            capturer = SharedProjectionScreenCapturer(mediaProjection!!, projectionCallback)
            source = factory!!.createVideoSource(true)
            textureHelper = SurfaceTextureHelper.create("CatEmpireScreen", context)
            capturer!!.initialize(textureHelper, applicationContext, source!!.capturerObserver)
            capturer!!.startCapture(width, height, safeFps)
            track = factory!!.createVideoTrack("cat-native-screen", source)
            diagnosticSink = VideoSink { frame ->
                if (firstFrameReported.compareAndSet(false, true)) {
                    firstFrameDetail = "${frame.rotatedWidth}x${frame.rotatedHeight}"
                    reportStage("first-frame", firstFrameDetail)
                }
            }.also { track!!.addSink(it) }
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
                reportStage("registered", "${viewers.length()} viewer(s)")
                firstFrameDetail?.let { reportStage("first-frame", it) }
                startPlaybackAudioCapture()
                peers.values.forEach { it.close() }
                peers.clear()
                pendingCandidates.clear()
                for (index in 0 until viewers.length()) {
                    viewers.optString(index).takeIf { it.isNotBlank() }?.let(::ensurePeerFor)
                }
                listener?.onState("started", profileLabel)
            }
        }
        client.on("native-screen-viewer-joined") { args ->
            val id = (args.firstOrNull() as? JSONObject)?.optString("userId").orEmpty()
            if (id.isNotBlank()) rtcExecutor.execute { ensurePeerFor(id) }
        }
        client.on("native-screen-viewer-left") { args ->
            val id = (args.firstOrNull() as? JSONObject)?.optString("userId").orEmpty()
            if (id.isNotBlank()) rtcExecutor.execute {
                peers.remove(id)?.close()
                pendingCandidates.remove(id)
            }
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

    private fun ensurePeerFor(viewerId: String): PeerConnection? {
        peers[viewerId]?.let { return it }
        val rtcConfig = PeerConnection.RTCConfiguration(listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        )).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val pc = factory?.createPeerConnection(rtcConfig, peerObserver(viewerId)) ?: return null
        peers[viewerId] = pc
        val sender = pc.addTrack(track ?: return null, listOf("cat-native-screen"))
        val parameters = sender.parameters
        parameters.encodings.forEach { encoding ->
            encoding.maxBitrateBps = broadcastBitrateBps
            encoding.maxFramerate = broadcastFps
        }
        sender.parameters = parameters
        return pc
    }

    private fun handleSignal(from: String, data: JSONObject) {
        val pc = peers[from] ?: ensurePeerFor(from) ?: return
        data.optJSONObject("sdp")?.let { sdp ->
            val isOffer = sdp.optString("type") == "offer"
            reportStage(if (isOffer) "offer-received" else "answer-received", from)
            val type = if (isOffer) SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER
            pc.setRemoteDescription(object : BasicSdpObserver() {
                override fun onSetSuccess() {
                    reportStage("remote-sdp-set", from)
                    pendingCandidates.remove(from)?.forEach { pc.addIceCandidate(it) }
                    if (!isOffer) return
                    pc.createAnswer(object : BasicSdpObserver() {
                        override fun onCreateSuccess(description: SessionDescription?) {
                            if (description == null) return
                            reportStage("answer-created", from)
                            pc.setLocalDescription(object : BasicSdpObserver() {
                                override fun onSetSuccess() {
                                    emitSignal(from, JSONObject().put("sdp", JSONObject()
                                        .put("type", description.type.canonicalForm())
                                        .put("sdp", description.description)))
                                    reportStage("answer-sent", from)
                                }
                                override fun onSetFailure(message: String?) = reportStage("local-sdp-error", message)
                            }, description)
                        }
                        override fun onCreateFailure(message: String?) = reportStage("answer-error", message)
                    }, MediaConstraints())
                }
                override fun onSetFailure(message: String?) = reportStage("remote-sdp-error", message)
            }, SessionDescription(type, sdp.optString("sdp")))
            return
        }
        data.optJSONObject("candidate")?.let { candidate ->
            val ice = IceCandidate(
                candidate.optString("sdpMid").ifBlank { null },
                candidate.optInt("sdpMLineIndex", 0),
                candidate.optString("candidate")
            )
            if (pc.remoteDescription == null) {
                pendingCandidates.computeIfAbsent(from) { mutableListOf() }.add(ice)
            } else pc.addIceCandidate(ice)
        }
    }

    private fun peerObserver(viewerId: String) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            reportStage("ice-${state?.name?.lowercase() ?: "unknown"}", viewerId)
            if (state == PeerConnection.IceConnectionState.FAILED || state == PeerConnection.IceConnectionState.CLOSED) {
                rtcExecutor.execute {
                    pendingCandidates.remove(viewerId)
                    peers.remove(viewerId)?.close()
                }
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

    private fun reportStage(stage: String, detail: String?) {
        socket?.emit("native-screen-debug", JSONObject()
            .put("stage", stage)
            .put("detail", detail ?: ""))
    }

    private fun startPlaybackAudioCapture() {
        if (!screenAudioAllowed || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || playbackAudioRunning.get()) {
            reportStage("screen-audio-unavailable", "Android 10+ e permissão de áudio são necessários")
            return
        }
        val projection = mediaProjection ?: return
        try {
            val sampleRate = 48_000
            val channelCount = 1
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build()
            val captureConfig = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .build()
            val minimum = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val packetBytes = 3_840 // 40 ms de PCM mono, 16-bit, 48 kHz.
            val record = AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(maxOf(minimum * 2, packetBytes * 4))
                .setAudioPlaybackCaptureConfig(captureConfig)
                .build()
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                throw IllegalStateException("AudioRecord não inicializado")
            }
            playbackAudioRecord = record
            playbackAudioRunning.set(true)
            playbackAudioSequence.set(0)
            record.startRecording()
            playbackAudioThread = Thread({
                Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
                val buffer = ByteArray(packetBytes)
                reportStage("screen-audio-started", "${sampleRate}Hz mono")
                while (playbackAudioRunning.get()) {
                    val read = try {
                        record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    } catch (_: Exception) { break }
                    if (read <= 0 || socket?.connected() != true) continue
                    val encoded = Base64.encodeToString(
                        if (read == buffer.size) buffer else buffer.copyOf(read),
                        Base64.NO_WRAP
                    )
                    socket?.emit("native-screen-audio", JSONObject()
                        .put("data", encoded)
                        .put("sampleRate", sampleRate)
                        .put("channels", channelCount)
                        .put("sequence", playbackAudioSequence.getAndIncrement()))
                }
            }, "CatEmpireScreenAudio").also { it.start() }
        } catch (error: Exception) {
            stopPlaybackAudioCapture()
            reportStage("screen-audio-error", error.message)
        }
    }

    private fun stopPlaybackAudioCapture() {
        playbackAudioRunning.set(false)
        try { playbackAudioRecord?.stop() } catch (_: Exception) {}
        try { playbackAudioThread?.join(750) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        playbackAudioThread = null
        playbackAudioRecord?.release()
        playbackAudioRecord = null
    }

    fun stopBroadcast() {
        if (!stopping.compareAndSet(false, true)) return
        rtcExecutor.execute { releaseBroadcast() }
    }

    private fun releaseBroadcast() {
        peers.values.forEach { it.close() }
        peers.clear()
        pendingCandidates.clear()
        socket?.disconnect()
        socket = null
        stopPlaybackAudioCapture()
        try { capturer?.stopCapture() } catch (_: Exception) {}
        capturer?.dispose(); capturer = null
        diagnosticSink?.let { sink -> try { track?.removeSink(sink) } catch (_: Exception) {} }
        diagnosticSink = null
        track?.dispose(); track = null
        source?.dispose(); source = null
        textureHelper?.dispose(); textureHelper = null
        factory?.dispose(); factory = null
        eglBase?.release(); eglBase = null
        try { mediaProjection?.stop() } catch (_: Exception) {}
        mediaProjection = null
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
            var serviceType = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            if (screenAudioAllowed) {
                serviceType = serviceType or android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            startForeground(NOTIFICATION_ID, notification, serviceType)
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
