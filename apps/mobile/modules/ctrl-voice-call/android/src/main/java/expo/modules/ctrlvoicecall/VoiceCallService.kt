package expo.modules.ctrlvoicecall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat

/**
 * Holds a voice conversation like a phone call: a microphone foreground service
 * keeps WebRTC capturing while the app is in the background or the screen is
 * locked, under an ongoing call notification (status-bar call chip, timer,
 * Hang up, Mute).
 */
class VoiceCallService : Service() {
  private var inForeground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    if (inForeground) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    // The system stopped the call: never leave the microphone running without it.
    if (wanted) onAction?.invoke(ACTION_NAME_END)
    super.onDestroy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_END -> {
        onAction?.invoke(ACTION_NAME_END)
        finish()
      }
      ACTION_TOGGLE_MUTE -> onAction?.invoke(ACTION_NAME_MUTE)
      else -> {
        if (!goForeground()) {
          onAction?.invoke(ACTION_NAME_END)
          finish()
        } else if (!wanted) {
          finish()
        }
      }
    }
    // A killed process has no conversation to resume.
    return START_NOT_STICKY
  }

  private fun goForeground(): Boolean {
    val notification = notification()
    val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    } else {
      0
    }
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types)
      inForeground = true
      return true
    } catch (error: RuntimeException) {
      // Android refuses a microphone service without the permission or from the background.
      Log.w(TAG, "Could not hold the voice conversation in the foreground", error)
    }
    // A started foreground service still owes startForeground, or Android stops the app.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      try {
        ServiceCompat.startForeground(
          this,
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        )
        inForeground = true
      } catch (error: RuntimeException) {
        Log.w(TAG, "Could not start the voice conversation service", error)
      }
    }
    return false
  }

  private fun finish() {
    wanted = false
    if (inForeground) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    inForeground = false
    stopSelf()
  }

  private fun refresh() {
    if (!inForeground) return
    getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification())
  }

  private fun notification(): Notification {
    val person = Person.Builder()
      .setName(caller)
      .setIcon(IconCompat.createWithResource(this, R.drawable.ctrl_voice_call))
      .setImportant(true)
      .build()
    val mute = NotificationCompat.Action.Builder(
      IconCompat.createWithResource(
        this,
        if (muted) R.drawable.ctrl_voice_mic else R.drawable.ctrl_voice_mic_off
      ),
      if (muted) "Unmute" else "Mute",
      serviceIntent(ACTION_TOGGLE_MUTE, 2)
    ).build()
    return NotificationCompat.Builder(this, ensureChannel(this))
      .setSmallIcon(R.drawable.ctrl_voice_call)
      .setContentTitle(title)
      .setContentText(status)
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, serviceIntent(ACTION_END, 1)))
      .addPerson(person)
      .addAction(mute)
      .setUsesChronometer(true)
      .setWhen(startedAtMs)
      .setShowWhen(true)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .apply { openIntent()?.let(::setContentIntent) }
      .build()
  }

  private fun openIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun serviceIntent(action: String, requestCode: Int): PendingIntent =
    PendingIntent.getService(
      this,
      requestCode,
      Intent(this, VoiceCallService::class.java).setAction(action),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  companion object {
    private const val TAG = "CtrlVoiceCall"
    private const val CHANNEL = "voice-call"
    private const val NOTIFICATION_ID = 0x766f6963
    private const val ACTION_END = "expo.modules.ctrlvoicecall.END"
    private const val ACTION_TOGGLE_MUTE = "expo.modules.ctrlvoicecall.TOGGLE_MUTE"
    const val ACTION_NAME_END = "end"
    const val ACTION_NAME_MUTE = "mute"

    /** Set by the module: Hang up and Mute in the notification are handled by JS. */
    @Volatile var onAction: ((String) -> Unit)? = null

    @Volatile private var instance: VoiceCallService? = null

    // Whether JS still holds a conversation; a start that lands after its stop ends at once.
    @Volatile private var wanted = false

    @Volatile private var caller = "Voice"

    @Volatile private var title = "Voice conversation"

    @Volatile private var status = "Connecting"

    @Volatile private var muted = false

    @Volatile private var startedAtMs = 0L

    fun start(
      context: Context,
      callerName: String,
      callTitle: String,
      callStatus: String,
      isMuted: Boolean
    ) {
      wanted = true
      caller = callerName
      title = callTitle
      status = callStatus
      muted = isMuted
      startedAtMs = System.currentTimeMillis()
      try {
        ContextCompat.startForegroundService(context, Intent(context, VoiceCallService::class.java))
      } catch (error: RuntimeException) {
        Log.w(TAG, "Could not start the voice conversation service", error)
        wanted = false
      }
    }

    fun update(context: Context, callStatus: String, isMuted: Boolean) {
      status = callStatus
      muted = isMuted
      Handler(context.mainLooper).post { instance?.refresh() }
    }

    fun stop(context: Context) {
      wanted = false
      // stopService before startForeground runs would crash the app; a pending start ends itself.
      Handler(context.mainLooper).post { instance?.finish() }
    }

    private fun ensureChannel(context: Context): String {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
          NotificationChannel(
            CHANNEL,
            "Voice conversations",
            NotificationManager.IMPORTANCE_DEFAULT
          )
            .apply {
              description = "Shown while you are in a voice conversation"
              setShowBadge(false)
              setSound(null, null)
              enableVibration(false)
            }
        )
      }
      return CHANNEL
    }
  }
}
