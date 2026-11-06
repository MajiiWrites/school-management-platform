package com.plansathi.schoolsms.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.plansathi.schoolsms.worker.ServiceState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** First-run setup: server URL + device credentials from the portal. */
@Composable
fun LoginScreen(onSave: (serverUrl: String, deviceId: String, deviceName: String, apiKey: String) -> Unit) {
    var serverUrl by remember { mutableStateOf("") }
    var deviceId by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Top,
    ) {
        Text("Connect this phone", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "This phone sends the school SMS from its own SIM. Get the device ID " +
                "and API key from the portal: Messages → SMS status → Register device.",
            fontSize = 14.sp,
        )
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Server URL (e.g. https://api.yourschool.pk)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = deviceId,
            onValueChange = { deviceId = it },
            label = { Text("Device ID") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = deviceName,
            onValueChange = { deviceName = it },
            label = { Text("Device name (e.g. Admin phone)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = apiKey,
            onValueChange = { apiKey = it },
            label = { Text("Device API key") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        if (error != null) {
            Spacer(Modifier.height(12.dp))
            Text(error!!, color = Color.Red, fontSize = 14.sp)
        }
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = {
                if (serverUrl.isBlank() || deviceId.isBlank() || apiKey.isBlank()) {
                    error = "Server URL, device ID and API key are all required."
                } else {
                    error = null
                    onSave(
                        serverUrl.trim(),
                        deviceId.trim(),
                        deviceName.trim().ifBlank { deviceId.trim() },
                        apiKey.trim(),
                    )
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Connect & start sending")
        }
    }
}

/** Home: connection status, queue depth, sent-today counter, actions. */
@Composable
fun HomeScreen(
    state: ServiceState.State,
    deviceName: String,
    onSyncNow: () -> Unit,
    onSignOut: () -> Unit,
) {
    val lastSync = if (state.lastSyncEpochMs > 0) {
        SimpleDateFormat("hh:mm:ss a", Locale.getDefault()).format(Date(state.lastSyncEpochMs))
    } else {
        "Never"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text("School SMS", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(deviceName, fontSize = 14.sp, color = Color.Gray)
        Spacer(Modifier.height(20.dp))

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = if (state.connected) Color(0xFFE8F5E9) else Color(0xFFFFEBEE),
            ),
        ) {
            Column(Modifier.padding(16.dp)) {
                Text(
                    if (state.connected) "● SIM connected — polling" else "● Offline — will retry",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(8.dp))
                Text("Messages waiting: ${state.queuedCount}")
                Text("Sent today: ${state.sentToday}")
                Text("Last sync: $lastSync")
                if (state.lastError != null) {
                    Text("Last error: ${state.lastError}", color = Color.Red)
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        Button(onClick = onSyncNow, modifier = Modifier.fillMaxWidth()) {
            Text("Sync now")
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) {
            Text("Sign out (unregister this phone)")
        }
        Spacer(Modifier.height(20.dp))
        Text(
            "Keep this app running — it polls the platform every 60 seconds and " +
                "sends approved parent messages from this SIM (max 1 message per 2 seconds).",
            fontSize = 13.sp,
            color = Color.Gray,
        )
    }
}
