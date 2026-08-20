package com.danonin.catempirecast

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
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
import android.widget.FrameLayout
import android.widget.ProgressBar
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * Cat Empire — app-casca em WebView.
 *
 * A ideia: em vez de reimplementar chat/canais/voz/câmera nativamente (o
 * site já faz tudo isso via Socket.io + WebRTC), a gente carrega o próprio
 * site dentro de um WebView de tela cheia e só cuida das pontes que um
 * navegador comum já resolveria sozinho, mas que dentro de um app precisam
 * de código explícito:
 *
 *  - Conceder permissão de câmera/microfone quando a página pede
 *    (getUserMedia) — sem isso, mic/câmera falham silenciosamente.
 *  - Abrir o seletor de arquivo/galeria quando a página pede
 *    (<input type=file>, usado no upload de imagem do chat).
 *  - Voltar de página com o botão físico/gesto de voltar do Android.
 *  - Puxar-pra-atualizar, tela de "sem conexão" com botão de tentar de novo.
 *
 * Compartilhar tela (getDisplayMedia) funciona por conta própria no
 * WebView em versões recentes (o próprio Chromium mostra o seletor nativo
 * de "iniciar gravação/transmissão"), mas depende da versão do WebView
 * instalada no aparelho — por isso mantemos o ScreenCaptureNotifier como
 * rede de segurança pro requisito de foreground service do Android 14+.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var loadingOverlay: View
    private lateinit var errorOverlay: View

    private var pendingPermissionRequest: PermissionRequest? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    // ---------- pedir permissão nativa de câmera/mic quando o WebView precisar ----------
    private val requestRuntimePermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) return@registerForActivityResult

        val granted = request.resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                    hasPermission(Manifest.permission.RECORD_AUDIO)
                PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                    hasPermission(Manifest.permission.CAMERA)
                else -> false
            }
        }.toTypedArray()

        if (granted.isNotEmpty()) request.grant(granted) else request.deny()
    }

    // ---------- seletor de arquivo/foto pro <input type=file> do chat ----------
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
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        errorOverlay = findViewById(R.id.errorOverlay)
        findViewById<Button>(R.id.retryButton).setOnClickListener { reload() }

        setupWebView()
        swipeRefresh.setOnRefreshListener { reload() }

        if (savedInstanceState == null) {
            webView.loadUrl(getString(R.string.app_base_url))
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    private fun setupWebView() {
        val s: WebSettings = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.userAgentString = s.userAgentString + " CatEmpireApp/1.0"

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                val host = request.url.host ?: ""

                // Mantém dentro do app: o próprio site e o fluxo de login
                // do Discord (discord.com -> autoriza -> redireciona de
                // volta pro domínio do site).
                if (host.endsWith("onrender.com") ||
                    host.endsWith("discord.com") ||
                    host == Uri.parse(getString(R.string.app_base_url)).host
                ) {
                    return false
                }

                // Qualquer outro link (ex: alguém compartilhou um link
                // externo no chat) abre no navegador de verdade.
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    true
                } catch (e: Exception) {
                    false
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                errorOverlay.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                loadingOverlay.visibility = View.GONE
                swipeRefresh.isRefreshing = false

                // Android 14+ exige foreground service tipo mediaProjection
                // rodando durante captura de tela. Como a gente não sabe
                // de antemão quando o usuário vai clicar em "compartilhar
                // tela" dentro da página, mantemos essa notificação
                // silenciosa ativa enquanto o usuário está dentro de uma
                // sala (server.html) — sai automaticamente ao fechar o app
                // ou voltar pra tela de login.
                if (url?.contains("server.html") == true) {
                    ScreenCaptureNotifier.start(this@MainActivity)
                } else {
                    ScreenCaptureNotifier.stop(this@MainActivity)
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    loadingOverlay.visibility = View.GONE
                    errorOverlay.visibility = View.VISIBLE
                    swipeRefresh.isRefreshing = false
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Nunca ignora erro de certificado — só cancela a navegação.
                handler.cancel()
                loadingOverlay.visibility = View.GONE
                errorOverlay.visibility = View.VISIBLE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            // câmera/microfone pedidos via getUserMedia/getDisplayMedia
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
                        // já concedidas no sistema — libera direto pro WebView
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

            // <input type="file"> do upload de imagem no chat
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "image/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                }
                val captureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                val chooser = Intent.createChooser(galleryIntent, "Escolher imagem").apply {
                    if (captureIntent.resolveActivity(packageManager) != null) {
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(captureIntent))
                    }
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
                if (newProgress >= 85) loadingOverlay.visibility = View.GONE
            }
        }
    }

    private fun reload() {
        errorOverlay.visibility = View.GONE
        webView.reload()
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        ScreenCaptureNotifier.stop(this)
        webView.destroy()
        super.onDestroy()
    }
}
