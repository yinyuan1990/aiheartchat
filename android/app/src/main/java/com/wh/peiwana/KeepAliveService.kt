package com.wh.peiwana

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.wh.peiwana.net.WsClient

/**
 * 保活服务：前台服务 + WakeLock + 静音音频 + 定时检查 IM 长连接。
 * 保证熄屏/后台时仍能收到消息与来电邀请。
 */
class KeepAliveService : Service() {

    companion object {
        private const val CHANNEL_ID = "peiwan_keepalive"
        private const val WS_CHECK_INTERVAL = 20_000L

        fun start(context: Context) {
            val intent = Intent(context, KeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private var audioTrack: AudioTrack? = null
    private var silenceThread: Thread? = null
    @Volatile private var running = false
    private var wakeLock: PowerManager.WakeLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
        startForeground(1, createNotification())
        running = true
        startSilentAudio()
        mainHandler.postDelayed(wsCheck, WS_CHECK_INTERVAL)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running) { running = true; startSilentAudio() }
        return START_STICKY
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "peiwan::KeepAlive").apply { acquire() }
    }

    /** 定时检查 IM 连接：connect() 幂等，断了会自动重建 */
    private val wsCheck = object : Runnable {
        override fun run() {
            if (!running) return
            runCatching { WsClient.connect() }
            mainHandler.postDelayed(this, WS_CHECK_INTERVAL)
        }
    }

    /** 静音音频：防止部分厂商系统深度休眠时冻结进程网络 */
    private fun startSilentAudio() {
        val sampleRate = 16000
        val bufSize = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(bufSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        audioTrack?.setVolume(0f)
        audioTrack?.play()
        silenceThread = Thread({
            val silence = ByteArray(bufSize)
            while (running) {
                try { audioTrack?.write(silence, 0, silence.size) } catch (_: Exception) { break }
            }
        }, "SilentAudio").apply { isDaemon = true; start() }
    }

    private fun createNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "消息保活", NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
        }
        val pending = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("陪玩")
            .setContentText("运行中，实时接收消息与来电")
            .setOngoing(true)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        running = false
        mainHandler.removeCallbacks(wsCheck)
        try { audioTrack?.stop(); audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null
        silenceThread?.interrupt()
        silenceThread = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
        // 被系统回收后自拉起
        runCatching { start(this) }
    }
}
