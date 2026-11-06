package com.plansathi.schoolsms.worker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.plansathi.schoolsms.data.DeliveryRequest
import com.plansathi.schoolsms.data.Prefs
import com.plansathi.schoolsms.data.SmsSender
import com.plansathi.schoolsms.data.buildApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * Shared, UI-observable connection state (updated by the service).
 * "Connected" = the last poll succeeded. The portal uses the same rule
 * (last_seen_at within 90 s) on its side.
 */
object ServiceState {
    data class State(
        val connected: Boolean = false,
        val lastSyncEpochMs: Long = 0L,
        val queuedCount: Int = 0,
        val sentToday: Int = 0,
        val lastError: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state = _state.asStateFlow()

    fun update(transform: (State) -> State) {
        _state.value = transform(_state.value)
    }
}

/**
 * Foreground service that polls the platform every 60 s for approved
 * queued messages, sends them via the SIM (SmsManager), and reports
 * delivery back — at most 1 message per 2 s (matches the server stagger).
 *
 * Why a foreground service and not just WorkManager: WorkManager's
 * periodic minimum is 15 minutes, but the spec requires a 60 s poll.
 * A WorkManager watchdog (SmsPollWorker) restarts this service if the
 * system kills it.
 *
 * Offline handling: a transient failure (no signal / no network) does NOT
 * report the message as failed — the row stays queued server-side and is
 * re-fetched on the next poll. Only after 3 consecutive failures for the
 * same message is it reported as failed (the admin can retry it from
 * the portal).
 */
class SmsPollService : Service() {
    companion object {
        const val ACTION_SYNC_NOW = "com.plansathi.schoolsms.SYNC_NOW"
        private const val CHANNEL_ID = "sms_poll"
        private const val NOTIFICATION_ID = 1
        private const val POLL_INTERVAL_MS = 60_000L
        private const val SEND_GAP_MS = 2_000L
        private const val MAX_CONSECUTIVE_FAILURES = 3

        fun start(context: Context) {
            val intent = Intent(context, SmsPollService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun syncNow(context: Context) {
            val intent = Intent(context, SmsPollService::class.java).apply {
                action = ACTION_SYNC_NOW
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SmsPollService::class.java))
        }
    }

    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private val consecutiveFailures = mutableMapOf<String, Int>()
    @Volatile
    private var syncRequested = false

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Starting…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_SYNC_NOW) syncRequested = true
        if (job == null) {
            job = scope.launch { pollLoop() }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        job?.cancel()
        job = null
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "School SMS sending",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps the SMS polling service running" }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("School SMS")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setOngoing(true)
            .build()

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            ?.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private suspend fun pollLoop() {
        while (scope.isActive) {
            pollOnce()
            // Wait 60 s (or less if a manual sync was requested).
            var waited = 0L
            while (waited < POLL_INTERVAL_MS && scope.isActive) {
                if (syncRequested) {
                    syncRequested = false
                    break
                }
                delay(1_000L)
                waited += 1_000L
            }
        }
    }

    private suspend fun pollOnce() {
        val prefs = Prefs(this)
        val serverUrl = prefs.serverUrl
        val deviceId = prefs.deviceId
        val apiKey = prefs.apiKey
        if (serverUrl.isNullOrBlank() || deviceId.isNullOrBlank() || apiKey.isNullOrBlank()) {
            ServiceState.update { it.copy(connected = false, lastError = "Not configured") }
            return
        }
        try {
            val api = buildApi(serverUrl)
            val response = api.getQueue(deviceId, apiKey)
            val messages = response.data?.messages.orEmpty()
            ServiceState.update {
                it.copy(
                    connected = true,
                    lastSyncEpochMs = System.currentTimeMillis(),
                    queuedCount = messages.size,
                    lastError = null,
                )
            }
            updateNotification(
                if (messages.isEmpty()) "Connected — no messages waiting"
                else "Connected — sending ${messages.size} message(s)",
            )
            for (message in messages) {
                val outcome = SmsSender.send(this, message.to, message.body, message.queueId)
                when (outcome) {
                    is SmsSender.SendOutcome.Sent -> {
                        consecutiveFailures.remove(message.queueId)
                        reportDelivery(api, deviceId, apiKey, message.queueId, "sent", null)
                        bumpSentToday(prefs)
                    }
                    is SmsSender.SendOutcome.Failed -> {
                        val count = (consecutiveFailures[message.queueId] ?: 0) + 1
                        consecutiveFailures[message.queueId] = count
                        if (count >= MAX_CONSECUTIVE_FAILURES) {
                            consecutiveFailures.remove(message.queueId)
                            reportDelivery(api, deviceId, apiKey, message.queueId, "failed", outcome.reason)
                        }
                        // Otherwise: leave queued — retried on the next poll.
                    }
                }
                delay(SEND_GAP_MS) // max 1 message per 2 s
            }
        } catch (e: Exception) {
            ServiceState.update { it.copy(connected = false, lastError = e.message) }
            updateNotification("Offline — will retry")
        }
    }

    private suspend fun reportDelivery(
        api: com.plansathi.schoolsms.data.SchoolSmsApi,
        deviceId: String,
        apiKey: String,
        queueId: String,
        status: String,
        error: String?,
    ) {
        try {
            api.reportDelivery(deviceId, apiKey, DeliveryRequest(queue_id = queueId, status = status, error = error))
        } catch (_: Exception) {
            // Delivery report failed (offline) — the queue row stays queued
            // server-side and will be re-fetched; the portal shows it as
            // still queued, which is the honest state.
        }
    }

    private fun bumpSentToday(prefs: Prefs) {
        val today = LocalDate.now().toString()
        val count = if (prefs.sentTodayDate == today) prefs.sentTodayCount else 0
        prefs.sentTodayDate = today
        prefs.sentTodayCount = count + 1
        ServiceState.update { it.copy(sentToday = count + 1) }
    }
}
