package com.mentra.core

import com.mentra.core.utils.ControllerTypes
import com.mentra.core.utils.DeviceTypes

data class MentraBluetoothSdkConfig(
    val deliverCallbacksOnMainThread: Boolean = true,
)

enum class MentraDeviceModel(val deviceType: String) {
    G1(DeviceTypes.G1),
    G2(DeviceTypes.G2),
    MENTRA_LIVE(DeviceTypes.LIVE),
    MENTRA_NEX(DeviceTypes.NEX),
    MACH1(DeviceTypes.MACH1),
    Z100(DeviceTypes.Z100),
    FRAME(DeviceTypes.FRAME),
    SIMULATED(DeviceTypes.SIMULATED),
    R1(ControllerTypes.R1);

    companion object {
        @JvmStatic
        fun fromDeviceType(deviceType: String?): MentraDeviceModel =
            values().firstOrNull { it.deviceType == deviceType } ?: MENTRA_LIVE
    }
}

data class MentraDiscoveredDevice(
    val model: MentraDeviceModel,
    val name: String,
    val address: String? = null,
    val rssi: Int? = null,
)

data class MentraPairedDevice(
    val model: MentraDeviceModel,
    val name: String,
    val address: String? = null,
)

data class MentraGlassesStatus(
    val values: Map<String, Any>,
)

data class MentraBluetoothStatus(
    val values: Map<String, Any>,
)

data class MentraGlassesStatusUpdate(
    val values: Map<String, Any>,
)

data class MentraBluetoothStatusUpdate(
    val values: Map<String, Any>,
)

data class MentraDisplayTextRequest(
    val text: String,
    val x: Int = 0,
    val y: Int = 0,
    val size: Int = 24,
) {
    fun toMap(): Map<String, Any> =
        mapOf(
            "text" to text,
            "x" to x,
            "y" to y,
            "size" to size,
        )
}

data class MentraDisplayEventRequest(
    val values: Map<String, Any>,
) {
    fun toMap(): Map<String, Any> = values
}

data class MentraDashboardPositionRequest(
    val height: Int,
    val depth: Int,
)

data class MentraDashboardMenuItem(
    val title: String,
    val packageName: String,
    val values: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> =
        values + mapOf(
            "title" to title,
            "packageName" to packageName,
        )
}

enum class MentraGalleryMode {
    AUTO,
    MANUAL,
}

enum class MentraPhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large"),
    FULL("full");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraPhotoSize =
            values().firstOrNull { it.value == value } ?: MEDIUM
    }
}

enum class MentraButtonPhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraButtonPhotoSize =
            values().firstOrNull { it.value == value } ?: MEDIUM
    }
}

enum class MentraPhotoCompression(val value: String) {
    NONE("none"),
    MEDIUM("medium"),
    HEAVY("heavy");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraPhotoCompression =
            values().firstOrNull { it.value == value } ?: NONE
    }
}

data class MentraButtonPhotoSettings(
    val size: MentraButtonPhotoSize,
)

data class MentraButtonVideoRecordingSettings(
    val width: Int,
    val height: Int,
    val fps: Int,
)

enum class MentraCameraFov(val fov: Int, val roiPosition: Int) {
    STANDARD(118, 0),
    WIDE(118, 0),
}

data class MentraMicConfig(
    val sendPcmData: Boolean,
    val sendTranscript: Boolean,
    val bypassVad: Boolean,
    val sendLc3Data: Boolean = false,
)

enum class MentraMicPreference(val value: String) {
    AUTO("auto"),
    PHONE("phone"),
    GLASSES("glasses"),
    BT_CLASSIC("btclassic"),
    BT("bt"),
}

data class MentraPhotoRequest @JvmOverloads constructor(
    val requestId: String,
    val appId: String,
    val size: MentraPhotoSize,
    val webhookUrl: String,
    val authToken: String? = null,
    val compress: MentraPhotoCompression = MentraPhotoCompression.MEDIUM,
    val flash: Boolean = false,
    val sound: Boolean = true,
)

data class MentraStreamVideoConfig @JvmOverloads constructor(
    val width: Int? = null,
    val height: Int? = null,
    val bitrate: Int? = null,
    val frameRate: Int? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            width?.let { "width" to it },
            height?.let { "height" to it },
            bitrate?.let { "bitrate" to it },
            frameRate?.let { "frameRate" to it },
        ).toMap()

    companion object {
        @JvmStatic
        fun fromMap(values: Map<*, *>?): MentraStreamVideoConfig? {
            values ?: return null
            return MentraStreamVideoConfig(
                width = numberValue(values, "width", "w"),
                height = numberValue(values, "height", "h"),
                bitrate = numberValue(values, "bitrate", "br"),
                frameRate = numberValue(values, "frameRate", "fr"),
            )
        }
    }
}

data class MentraStreamAudioConfig @JvmOverloads constructor(
    val bitrate: Int? = null,
    val sampleRate: Int? = null,
    val echoCancellation: Boolean? = null,
    val noiseSuppression: Boolean? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            bitrate?.let { "bitrate" to it },
            sampleRate?.let { "sampleRate" to it },
            echoCancellation?.let { "echoCancellation" to it },
            noiseSuppression?.let { "noiseSuppression" to it },
        ).toMap()

    companion object {
        @JvmStatic
        fun fromMap(values: Map<*, *>?): MentraStreamAudioConfig? {
            values ?: return null
            return MentraStreamAudioConfig(
                bitrate = numberValue(values, "bitrate", "br"),
                sampleRate = numberValue(values, "sampleRate", "sr"),
                echoCancellation = values["echoCancellation"] as? Boolean ?: values["ec"] as? Boolean,
                noiseSuppression = values["noiseSuppression"] as? Boolean ?: values["ns"] as? Boolean,
            )
        }
    }
}

data class MentraStreamRequest @JvmOverloads constructor(
    val streamUrl: String,
    val streamId: String = "",
    val keepAlive: Boolean = true,
    val keepAliveIntervalSeconds: Int = 15,
    val flash: Boolean = true,
    val sound: Boolean = true,
    val video: MentraStreamVideoConfig? = null,
    val audio: MentraStreamAudioConfig? = null,
    val extraValues: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> {
        val values = extraValues.toMutableMap()
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["keepAlive"] = keepAlive
        values["keepAliveIntervalSeconds"] = keepAliveIntervalSeconds
        values["flash"] = flash
        values["sound"] = sound
        video?.toMap()?.takeIf { it.isNotEmpty() }?.let { values["video"] = it }
        audio?.toMap()?.takeIf { it.isNotEmpty() }?.let { values["audio"] = it }
        return values
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): MentraStreamRequest =
            MentraStreamRequest(
                streamUrl =
                    (values["streamUrl"] ?: values["rtmpUrl"] ?: values["srtUrl"] ?: values["whipUrl"]) as? String
                        ?: "",
                streamId = values["streamId"] as? String ?: "",
                keepAlive = values["keepAlive"] as? Boolean ?: true,
                keepAliveIntervalSeconds = (values["keepAliveIntervalSeconds"] as? Number)?.toInt() ?: 15,
                flash = values["flash"] as? Boolean ?: true,
                sound = values["sound"] as? Boolean ?: true,
                video = MentraStreamVideoConfig.fromMap((values["video"] ?: values["v"]) as? Map<*, *>),
                audio = MentraStreamAudioConfig.fromMap((values["audio"] ?: values["a"]) as? Map<*, *>),
                extraValues = values,
            )
    }
}

data class MentraStreamKeepAliveRequest @JvmOverloads constructor(
    val streamId: String,
    val ackId: String,
    val extraValues: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> {
        val values = extraValues.toMutableMap()
        values["type"] = "keep_stream_alive"
        values["streamId"] = streamId
        values["ackId"] = ackId
        return values
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): MentraStreamKeepAliveRequest =
            MentraStreamKeepAliveRequest(
                streamId = values["streamId"] as? String ?: "",
                ackId = values["ackId"] as? String ?: "",
                extraValues = values,
            )
    }
}

enum class MentraRgbLedAction(val value: String) {
    ON("on"),
    OFF("off");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraRgbLedAction =
            values().firstOrNull { it.value == value } ?: OFF
    }
}

enum class MentraRgbLedColor(val value: String) {
    RED("red"),
    GREEN("green"),
    BLUE("blue"),
    ORANGE("orange"),
    WHITE("white");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraRgbLedColor? =
            values().firstOrNull { it.value == value }
    }
}

data class MentraRgbLedRequest @JvmOverloads constructor(
    val requestId: String,
    val packageName: String?,
    val action: MentraRgbLedAction,
    val color: MentraRgbLedColor?,
    val ontime: Int,
    val offtime: Int,
    val count: Int,
)

data class MentraVideoRecordingRequest(
    val requestId: String,
    val save: Boolean,
    val flash: Boolean,
    val sound: Boolean,
)

data class MentraButtonPressEvent(
    val buttonId: String,
    val pressType: String,
    val timestamp: Long? = null,
)

data class MentraTouchEvent(
    val values: Map<String, Any>,
)

data class MentraBatteryStatusEvent(
    val level: Int?,
    val charging: Boolean?,
    val values: Map<String, Any>,
)

data class MentraWifiStatusEvent(
    val values: Map<String, Any>,
)

data class MentraGalleryStatusEvent(
    val values: Map<String, Any>,
)

data class MentraPhotoResponseEvent(
    val values: Map<String, Any>,
)

data class MentraStreamStatusEvent(
    val values: Map<String, Any>,
)

data class MentraLocalTranscriptionEvent(
    val text: String,
    val isFinal: Boolean,
    val values: Map<String, Any>,
)

data class MentraBluetoothError(
    val code: String,
    val message: String,
    val cause: Throwable? = null,
)

enum class MentraScanStopReason {
    COMPLETED,
    CANCELLED,
    ERROR,
}

interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {}
    fun onDeviceDiscovered(device: MentraDiscoveredDevice) {}
    fun onScanStopped(reason: MentraScanStopReason) {}
    fun onButtonPress(event: MentraButtonPressEvent) {}
    fun onTouch(event: MentraTouchEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: MentraBatteryStatusEvent) {}
    fun onWifiStatusChanged(event: MentraWifiStatusEvent) {}
    fun onGalleryStatus(event: MentraGalleryStatusEvent) {}
    fun onPhotoResponse(event: MentraPhotoResponseEvent) {}
    fun onStreamStatus(event: MentraStreamStatusEvent) {}
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
    fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: MentraPairedDevice?) {}
    fun onLog(message: String) {}
    fun onError(error: MentraBluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener

private fun numberValue(
    values: Map<*, *>,
    fullKey: String,
    compactKey: String,
): Int? = ((values[fullKey] ?: values[compactKey]) as? Number)?.toInt()
