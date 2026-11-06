package com.plansathi.schoolsms

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.plansathi.schoolsms.data.Prefs
import com.plansathi.schoolsms.ui.HomeScreen
import com.plansathi.schoolsms.ui.LoginScreen
import com.plansathi.schoolsms.worker.ServiceState
import com.plansathi.schoolsms.worker.SmsPollService
import com.plansathi.schoolsms.worker.SmsPollWorker

class MainActivity : ComponentActivity() {

    private lateinit var prefs: Prefs
    private var hasSmsPermission by mutableStateOf(false)
    private var configured by mutableStateOf(false)

    private val smsPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasSmsPermission = granted
        if (granted && configured) SmsPollService.start(this)
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* notification permission is best-effort; service works without it */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        configured = prefs.isConfigured
        hasSmsPermission = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.SEND_SMS,
        ) == PackageManager.PERMISSION_GRANTED

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (hasSmsPermission && configured) {
            SmsPollService.start(this)
        }
        SmsPollWorker.enqueue(this)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val state by ServiceState.state.collectAsState()
                    when {
                        !hasSmsPermission -> Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(24.dp),
                        ) {
                            Text(
                                "SMS permission needed",
                                style = MaterialTheme.typography.headlineSmall,
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "Without SEND_SMS permission this phone cannot send parent " +
                                    "messages. Please grant it to continue.",
                            )
                            Spacer(Modifier.height(20.dp))
                            Button(onClick = {
                                smsPermissionLauncher.launch(Manifest.permission.SEND_SMS)
                            }) {
                                Text("Grant SMS permission")
                            }
                        }
                        !configured -> LoginScreen { serverUrl, deviceId, deviceName, apiKey ->
                            prefs.serverUrl = serverUrl
                            prefs.deviceId = deviceId
                            prefs.deviceName = deviceName
                            prefs.apiKey = apiKey
                            configured = true
                            if (hasSmsPermission) SmsPollService.start(this)
                        }
                        else -> HomeScreen(
                            state = state,
                            deviceName = prefs.deviceName ?: prefs.deviceId.orEmpty(),
                            onSyncNow = { SmsPollService.syncNow(this) },
                            onSignOut = {
                                SmsPollService.stop(this)
                                prefs.clear()
                                configured = false
                            },
                        )
                    }
                }
            }
        }
    }
}
