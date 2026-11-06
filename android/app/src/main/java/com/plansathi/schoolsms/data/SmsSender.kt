package com.plansathi.schoolsms.data

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.telephony.SmsManager
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/**
 * Sends one SMS via the phone's SIM (SmsManager) and awaits the
 * sent-result. Result codes come from the SMS stack, not the network:
 * RESULT_OK means the radio accepted the message; anything else is a
 * send failure (no signal, radio off, generic failure).
 *
 * A dynamic BroadcastReceiver is registered once per process (see
 * [ensureReceiver]) and routes results back by queueId.
 */
object SmsSender {
    private const val ACTION_SMS_SENT = "com.plansathi.schoolsms.SMS_SENT"
    private const val EXTRA_QUEUE_ID = "queue_id"

    private val pending = ConcurrentHashMap<String, (Int) -> Unit>()
    private var receiverRegistered = false

    fun ensureReceiver(context: Context) {
        if (receiverRegistered) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val queueId = intent.getStringExtra(EXTRA_QUEUE_ID) ?: return
                pending.remove(queueId)?.invoke(resultCode)
            }
        }
        val filter = IntentFilter(ACTION_SMS_SENT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        receiverRegistered = true
    }

    sealed class SendOutcome {
        object Sent : SendOutcome()
        data class Failed(val reason: String) : SendOutcome()
    }

    /**
     * Send one SMS. Returns Sent only when the radio reports RESULT_OK.
     * Throws nothing — failures are returned as Failed (so the caller can
     * decide: transient failure = leave queued and retry next poll).
     */
    suspend fun send(context: Context, to: String, body: String, queueId: String): SendOutcome {
        ensureReceiver(context)
        val sentIntent = Intent(ACTION_SMS_SENT).apply {
            putExtra(EXTRA_QUEUE_ID, queueId)
            setPackage(context.packageName)
        }
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            queueId.hashCode(),
            sentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return try {
            val resultCode = suspendCancellableCoroutine<Int> { cont ->
                pending[queueId] = { code -> cont.resume(code) }
                try {
                    @Suppress("DEPRECATION")
                    SmsManager.getDefault()
                        .sendTextMessage(to, null, body, pendingIntent, null)
                } catch (e: Exception) {
                    pending.remove(queueId)
                    cont.resume(Activity.RESULT_CANCELED)
                }
            }
            if (resultCode == Activity.RESULT_OK) {
                SendOutcome.Sent
            } else {
                SendOutcome.Failed("sms_result_code=$resultCode")
            }
        } catch (e: Exception) {
            SendOutcome.Failed(e.message ?: "send_exception")
        } finally {
            pending.remove(queueId)
        }
    }

    /** Unique request code helper (unused — queueId hash is the code). */
    @Suppress("unused")
    fun newRequestCode(): Int = UUID.randomUUID().hashCode()
}
