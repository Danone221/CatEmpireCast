package com.danonin.catempirecast

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Serviço em primeiro plano bem simples. Não faz captura de tela nenhuma
 * — quem faz isso é o próprio WebView/Chromium quando a página chama
 * getDisplayMedia(). Ele só existe porque, a partir do Android 14 (API 34),
 * o sistema operacional exige que exista um foreground service do tipo
 * "mediaProjection" rodando enquanto uma captura de tela estiver ativa,
 * senão a captura é recusada.
 *
 * A MainActivity liga isso ao entrar numa sala (server.html) e desliga ao
 * sair, então fica pronto pra quando o usuário apertar "compartilhar tela"
 * dentro da página.
 */
class ScreenCaptureNotifier : Service() {

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Cat Empire — chamada ativa",
                NotificationManager.IMPORTANCE_MIN
            )
            manager.createNotificationChannel(channel)
        }

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Cat Empire")
            .setContentText("Pronto pra compartilhar tela na chamada")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setPriority(NotificationCompat.PRIORITY_MIN)
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
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "screen_capture_ready"
        private const val NOTIFICATION_ID = 4201

        fun start(context: Context) {
            val intent = Intent(context, ScreenCaptureNotifier::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ScreenCaptureNotifier::class.java))
        }
    }
}
