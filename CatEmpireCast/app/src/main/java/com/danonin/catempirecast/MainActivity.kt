package com.danonin.catempirecast

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.MediaStore
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.danonin.catempirecast.databinding.ActivityMainBinding

/** Cat Empire — app-casca em WebView. */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private var pendingPermissionRequest: PermissionRequest? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val requestRuntimePermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) return@registerForActivityResult

        val granted = request.resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> hasPermission(Manifest.permission.RECORD_AUDIO)
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> hasPermission(Manifest.permission.CAMERA)
                else -> false
            }
        }.toTypedArray()

        if (granted.isNotEmpty()) request.grant(granted) else request.deny()
    }

    // ===== Transmissão nativa de tela (RTMP via BroadcastService) =====
    private var broadcastService: BroadcastService? = null
    private var broadcastBound = false
    private var pendingCastUrl: String? = null
    private var pendingCastKey: String? = null
    private var pendingCastQuality = 720
    private var pendingCastFps = 30
    private var pendingProjectionResultCode: Int? = null
    private var pendingProjectionData: Intent? = null

    private val broadcastConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val binder = service as BroadcastService.LocalBinder
            broadcastService = binder.getService()
            broadcastBound = true
            broadcastService?.setListener(object : BroadcastService.BroadcastStateListener {
                override fun onState(state: String, message: String?) {
                    runOnUiThread { notifyWebBroadcastState(state, message) }
                }
            })
            startPendingBroadcastIfReady()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            broadcastService = null
            broadcastBound = false
        }
    }

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val projectionData = result.data
        if (result.resultCode != RESULT_OK || projectionData == null) {
            clearPendingBroadcast()
            notifyWebBroadcastState("error", "Permissão de captura de tela negada.")
            return@registerForActivityResult
        }
        pendingProjectionResultCode = result.resultCode
        pendingProjectionData = projectionData
        if (pendingCastUrl.isNullOrBlank() || pendingCastKey.isNullOrBlank()) {
            notifyWebBroadcastState("ready", "Captura de tela autorizada.")
            return@registerForActivityResult
        }
        if (broadcastBound && broadcastService != null) {
            startPendingBroadcastIfReady()
        } else {
            val didBind = bindService(
                BroadcastService.intent(this),
                broadcastConnection,
                Context.BIND_AUTO_CREATE
            )
            if (!didBind) {
                clearPendingBroadcast()
                notifyWebBroadcastState("error", "Não foi possível iniciar o serviço de transmissão.")
            }
        }
    }

    private fun startPendingBroadcastIfReady() {
        val service = broadcastService ?: return
        val resultCode = pendingProjectionResultCode ?: return
        val projectionData = pendingProjectionData ?: return
        val url = pendingCastUrl ?: return
        val key = pendingCastKey ?: return
        val quality = pendingCastQuality
        val fps = pendingCastFps
        clearPendingBroadcast()
        service.startBroadcast(resultCode, projectionData, url, key, quality, fps)
    }

    private fun clearPendingBroadcast() {
        pendingCastUrl = null
        pendingCastKey = null
        pendingProjectionResultCode = null
        pendingProjectionData = null
    }

    private fun validateRtmpEndpoint(rtmpUrl: String?, streamKey: String?): String? {
        val raw = rtmpUrl?.trim().orEmpty()
        if (raw.isBlank()) return "Servidor RTMP não configurado."
        if (raw.contains("SEU_HOST_DE_MIDIA", ignoreCase = true)) {
            return "Servidor RTMP não configurado. Defina o host público de mídia no backend."
        }
        val uri = try { Uri.parse(raw) } catch (_: Exception) { null }
        val scheme = uri?.scheme?.lowercase()
        val host = uri?.host
        if (scheme != "rtmp" && scheme != "rtmps") return "Endpoint RTMP inválido."
        if (host.isNullOrBlank()) return "Endpoint RTMP sem endereço de servidor."
        if (streamKey.isNullOrBlank()) return "Chave de transmissão inválida."
        return null
    }

    private inner class WebAppInterface {
        @JavascriptInterface
        fun prepareBroadcast(quality: Int, fps: Int) {
            runOnUiThread {
                clearPendingBroadcast()
                pendingCastQuality = if (quality in setOf(480, 720, 1080)) quality else 720
                pendingCastFps = if (fps in setOf(24, 30, 60)) fps else 30
                val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                try {
                    screenCaptureLauncher.launch(projectionManager.createScreenCaptureIntent())
                } catch (e: Exception) {
                    notifyWebBroadcastState("error", "Não foi possível abrir a captura de tela.")
                }
            }
        }

        @JavascriptInterface
        fun startPreparedBroadcast(rtmpUrl: String?, streamKey: String?, quality: Int, fps: Int) {
            runOnUiThread {
                val validationError = validateRtmpEndpoint(rtmpUrl, streamKey)
                if (validationError != null) {
                    notifyWebBroadcastState("error", validationError)
                    return@runOnUiThread
                }
                pendingCastUrl = rtmpUrl?.trim()
                pendingCastKey = streamKey?.trim()
                pendingCastQuality = if (quality in setOf(480, 720, 1080)) quality else pendingCastQuality
                pendingCastFps = if (fps in setOf(24, 30, 60)) fps else pendingCastFps
                if (pendingProjectionData == null || pendingProjectionResultCode == null) {
                    prepareBroadcast(pendingCastQuality, pendingCastFps)
                    return@runOnUiThread
                }
                if (broadcastBound && broadcastService != null) {
                    startPendingBroadcastIfReady()
                } else {
                    val didBind = bindService(
                        BroadcastService.intent(this@MainActivity),
                        broadcastConnection,
                        Context.BIND_AUTO_CREATE
                    )
                    if (!didBind) {
                        clearPendingBroadcast()
                        notifyWebBroadcastState("error", "Não foi possível iniciar o serviço de transmissão.")
                    }
                }
            }
        }

        @JavascriptInterface
        fun startBroadcast(rtmpUrl: String?, streamKey: String?, quality: Int, fps: Int) {
            runOnUiThread {
                val validationError = validateRtmpEndpoint(rtmpUrl, streamKey)
                if (validationError != null) {
                    notifyWebBroadcastState("error", validationError)
                    return@runOnUiThread
                }
                pendingCastUrl = rtmpUrl?.trim()
                pendingCastKey = streamKey?.trim()
                pendingCastQuality = if (quality in setOf(480, 720, 1080)) quality else 720
                pendingCastFps = if (fps in setOf(24, 30, 60)) fps else 30
                val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                try {
                    screenCaptureLauncher.launch(projectionManager.createScreenCaptureIntent())
                } catch (e: Exception) {
                    notifyWebBroadcastState("error", "Não foi possível abrir a captura de tela.")
                }
            }
        }

        @JavascriptInterface
        fun stopBroadcast() {
            runOnUiThread {
                clearPendingBroadcast()
                broadcastService?.stopBroadcast()
                if (broadcastBound) {
                    unbindService(broadcastConnection)
                    broadcastBound = false
                }
            }
        }
    }

    private fun notifyWebBroadcastState(state: String, message: String?) {
        val safeMessage = (message ?: "").replace("\\", "\\\\").replace("'", "\\'")
        val js = "window.onNativeBroadcastState && window.onNativeBroadcastState('$state', '$safeMessage');"
        binding.webView.evaluateJavascript(js, null)
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode != RESULT_OK || result.data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val data = result.data
        val uris: Array<Uri> = when {
            data?.clipData != null -> {
                val clip = data.clipData!!
                Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
            }
            data?.data != null -> arrayOf(data.data!!)
            else -> emptyArray()
        }
        callback.onReceiveValue(if (uris.isEmpty()) null else uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) binding.webView.goBack()
                else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        setupWebView()
        binding.swipeRefresh.setOnRefreshListener { reload() }
        if (savedInstanceState == null) binding.webView.loadUrl(getString(R.string.app_base_url))
        binding.retryButton.setOnClickListener { reload() }
    }

    private fun setupWebView() {
        val s: WebSettings = binding.webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        val cachePrefs = getSharedPreferences("cat_empire_web_cache", MODE_PRIVATE)
        val cachedVersion = cachePrefs.getInt("app_version", 0)
        if (cachedVersion < BuildConfig.VERSION_CODE) {
            binding.webView.clearCache(true)
            cachePrefs.edit().putInt("app_version", BuildConfig.VERSION_CODE).apply()
        }
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.userAgentString = s.userAgentString + " CatEmpireApp/1.0"

        binding.webView.addJavascriptInterface(WebAppInterface(), "CatEmpireNative")

        binding.webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: ""
                if (host.endsWith("onrender.com") || host.endsWith("discord.com") || host == Uri.parse(getString(R.string.app_base_url)).host) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    true
                } catch (e: Exception) { false }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                binding.errorOverlay.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                binding.loadingOverlay.visibility = View.GONE
                binding.swipeRefresh.isRefreshing = false
                view.evaluateJavascript(
                    "document.documentElement.classList.add('cat-native-app');" +
                        "if(document.body)document.body.classList.add('cat-native-app');",
                    null
                )
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    binding.loadingOverlay.visibility = View.GONE
                    binding.errorOverlay.visibility = View.VISIBLE
                    binding.swipeRefresh.isRefreshing = false
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                binding.loadingOverlay.visibility = View.GONE
                binding.errorOverlay.visibility = View.VISIBLE
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val needed = request.resources.mapNotNull { resource ->
                        when (resource) {
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                            else -> null
                        }
                    }.filter { !hasPermission(it) }

                    if (needed.isEmpty()) {
                        val resources = request.resources.filter {
                            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                        }.toTypedArray()
                        if (resources.isNotEmpty()) request.grant(resources) else request.deny()
                    } else {
                        pendingPermissionRequest = request
                        requestRuntimePermissions.launch(needed.toTypedArray())
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                pendingPermissionRequest = null
            }

            override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "image/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                }
                val captureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                val chooser = Intent.createChooser(galleryIntent, "Escolher imagem").apply {
                    if (captureIntent.resolveActivity(packageManager) != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(captureIntent))
                }
                return try {
                    fileChooserLauncher.launch(chooser)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }

            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (newProgress >= 85) binding.loadingOverlay.visibility = View.GONE
            }
        }
    }

    private fun reload() {
        binding.errorOverlay.visibility = View.GONE
        binding.webView.reload()
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        if (broadcastBound) {
            broadcastService?.stopBroadcast()
            unbindService(broadcastConnection)
            broadcastBound = false
        }
        binding.webView.destroy()
        super.onDestroy()
    }
}
