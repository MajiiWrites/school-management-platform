package com.plansathi.schoolsms.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encrypted on-device settings: server URL, device ID/name and the
 * school-scoped device API key (from the portal's Register device flow).
 * The API key is never logged.
 */
class Prefs(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "school_sms_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(v) = prefs.edit().putString("server_url", v).apply()

    var deviceId: String?
        get() = prefs.getString("device_id", null)
        set(v) = prefs.edit().putString("device_id", v).apply()

    var deviceName: String?
        get() = prefs.getString("device_name", null)
        set(v) = prefs.edit().putString("device_name", v).apply()

    var apiKey: String?
        get() = prefs.getString("api_key", null)
        set(v) = prefs.edit().putString("api_key", v).apply()

    /** Messages sent today (local counter, reset when the date changes). */
    var sentTodayCount: Int
        get() = prefs.getInt("sent_today_count", 0)
        set(v) = prefs.edit().putInt("sent_today_count", v).apply()

    var sentTodayDate: String?
        get() = prefs.getString("sent_today_date", null)
        set(v) = prefs.edit().putString("sent_today_date", v).apply()

    val isConfigured: Boolean
        get() = !serverUrl.isNullOrBlank() && !deviceId.isNullOrBlank() && !apiKey.isNullOrBlank()

    fun clear() {
        prefs.edit().clear().apply()
    }
}
