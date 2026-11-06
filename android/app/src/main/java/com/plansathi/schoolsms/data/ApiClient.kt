package com.plansathi.schoolsms.data

import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

/** One queued message handed to this device. `to` is the full E.164 number. */
data class QueueMessage(
    val queueId: String,
    val to: String,
    val body: String,
    val type: String,
)

data class QueueData(val messages: List<QueueMessage> = emptyList())

data class QueueResponse(val ok: Boolean, val data: QueueData? = null)

data class DeliveryRequest(
    val queue_id: String,
    val status: String, // "sent" | "failed"
    val error: String? = null,
)

data class GenericResponse(val ok: Boolean)

/**
 * Platform API (backend: modules/messaging/routes.ts).
 * Base URL is the server origin + "/api/v1/" (added by buildApi).
 */
interface SchoolSmsApi {
    @GET("sms/devices/{deviceId}/queue")
    suspend fun getQueue(
        @Path("deviceId") deviceId: String,
        @Header("X-Device-Key") apiKey: String,
    ): QueueResponse

    @POST("sms/devices/{deviceId}/delivery")
    suspend fun reportDelivery(
        @Path("deviceId") deviceId: String,
        @Header("X-Device-Key") apiKey: String,
        @Body body: DeliveryRequest,
    ): GenericResponse
}

fun buildApi(serverUrl: String): SchoolSmsApi {
    val base = serverUrl.trimEnd('/') + "/api/v1/"
    return Retrofit.Builder()
        .baseUrl(base)
        .addConverterFactory(GsonConverterFactory.create())
        .build()
        .create(SchoolSmsApi::class.java)
}
