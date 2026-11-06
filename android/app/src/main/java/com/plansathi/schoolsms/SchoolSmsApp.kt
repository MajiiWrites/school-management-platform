package com.plansathi.schoolsms

import android.app.Application
import com.plansathi.schoolsms.worker.SmsPollWorker

class SchoolSmsApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Watchdog that restarts the polling service if the system kills it.
        SmsPollWorker.enqueue(this)
    }
}
