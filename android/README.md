# School SMS — Android companion app

Sends approved parent SMS from the **admin's own SIM**. The platform queues
approved messages; this app polls the queue, sends each SMS with
`SmsManager`, and reports delivery back.

## How it works

```
Portal (admin)                          This phone (SIM)
  POST /sms/devices/register  ──►  admin copies device ID + API key
  GET  /sms/devices/:id/queue ◄──  foreground service polls every 60 s
  POST /sms/devices/:id/delivery ◄── app reports sent/failed per message
```

- **Polling:** foreground service (`SmsPollService`) polls every 60 s.
  WorkManager cannot poll that fast (15 min minimum), so a `SmsPollWorker`
  watchdog runs every 15 min and restarts the service if killed.
- **Rate limit:** max 1 message per 2 s (matches the server stagger).
- **Offline:** a transient failure (no signal / no network) does NOT report
  the message as failed — the row stays queued server-side and is
  re-fetched on the next poll. After 3 consecutive failures for the same
  message it is reported as `failed` (admin retries it from the portal).
- **Credentials:** server URL, device ID and API key are stored in
  `EncryptedSharedPreferences`. The API key is never logged.
- **Delivery:** send results come from the SMS stack (`SmsManager` sent
  PendingIntent): `RESULT_OK` = radio accepted the message.

## Setup (admin)

1. In the portal: **Messages → SMS status → Register device** — enter a
   device ID (e.g. `admin-phone-1`) and a name. Copy the API key shown once.
2. Install this app on the phone with the SIM, open it, and enter:
   server URL (e.g. `https://api.yourschool.pk`), device ID, device name,
   API key. Tap **Connect & start sending**.
3. Grant **SEND_SMS** when asked (runtime permission). Keep the app
   running; the portal shows "SIM connected" when the phone polls
   (last seen within 90 s).

## Build & run

Requirements: Android Studio Hedgehog or newer, JDK 17, Android SDK 34.

```bash
cd android
./gradlew assembleDebug          # APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug           # install on a connected device/emulator
```

- `minSdk 26`, `targetSdk 34`, Kotlin + Jetpack Compose.
- No Gradle wrapper jar is bundled — Android Studio generates it on first
  import, or run `gradle wrapper` with a local Gradle 8.5 install.

## Project layout

| Path | What it is |
|---|---|
| `app/src/main/java/com/plansathi/schoolsms/MainActivity.kt` | Entry: permission gate → login/setup → home |
| `ui/Screens.kt` | Compose screens: Login (setup) + Home (status/queue/sent-today) |
| `data/ApiClient.kt` | Retrofit API (queue poll + delivery report) |
| `data/Prefs.kt` | Encrypted settings (server URL, device ID, API key) |
| `data/SmsSender.kt` | `SmsManager` send + sent-result await |
| `worker/SmsPollService.kt` | Foreground service: 60 s poll loop, 2 s send gap, offline retry |
| `worker/SmsPollWorker.kt` | WorkManager watchdog (15 min) that restarts the service |
| `SchoolSmsApp.kt` | Application: enqueues the watchdog |

## Build status

> ⚠️ **Not compiled in this environment** — no Android SDK/JDK is
> installed on the build machine, so `./gradlew assembleDebug` could not
> be run here. The project structure, manifest, and sources are complete;
> run the build in Android Studio (or any machine with SDK 34) before
> distributing the APK. The backend module it talks to is fully tested
> (`backend/src/modules/messaging/` — 16 unit tests passing).

## Permissions

- `SEND_SMS` (runtime, required), `INTERNET`, `FOREGROUND_SERVICE`,
  `RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS` (Android 13+).
