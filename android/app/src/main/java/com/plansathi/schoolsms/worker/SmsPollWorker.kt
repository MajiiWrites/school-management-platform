package com.plansathi.schoolsms.worker

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.plansathi.schoolsms.data.Prefs
import java.util.concurrent.TimeUnit

/**
 * Watchdog: WorkManager's periodic minimum is 15 minutes, so it cannot do
 * the 60 s poll itself. Instead it runs every 15 minutes and restarts the
 * foreground SmsPollService if the system killed it.
 */
class SmsPollWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    companion object {
        private const val UNIQUE_NAME = "sms-poll-watchdog"

        fun enqueue(context: Context) {
            val request = PeriodicWorkRequestBuilder<SmsPollWorker>(15, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }

    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        if (prefs.isConfigured) {
            SmsPollService.start(applicationContext)
        }
        return Result.success()
    }
}
