package com.mentra.core

import com.mentra.core.utils.ControllerTypes
import com.mentra.core.utils.DeviceTypes

data class BluetoothSdkConfig(
        val deliverCallbacksOnMainThread: Boolean = true,
)

enum class DeviceModel(val deviceType: String) {
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
        fun fromDeviceType(deviceType: String?): DeviceModel =
                values().firstOrNull { it.deviceType == deviceType } ?: MENTRA_LIVE
    }
}

data class MentraDiscoveredDevice(
        val model: DeviceModel,
        val name: String,
        val address: String? = null,
        val rssi: Int? = null,
)

data class PairedDevice(
        val model: DeviceModel,
        val name: String,
        val address: String? = null,
)

data class GlassesStatus(
        val values: Map<String, Any>,
)

data class BluetoothStatus(
        val values: Map<String, Any>,
)

data class GlassesStatusUpdate(
        val values: Map<String, Any>,
)

data class BluetoothStatusUpdate(
        val values: Map<String, Any>,
)

data class DisplayTextRequest(
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

data class DisplayEventRequest(
        val values: Map<String, Any>,
) {
    fun toMap(): Map<String, Any> = values
}

data class DashboardPositionRequest(
        val height: Int,
        val depth: Int,
)

data class DashboardMenuItem(
        val title: String,
        val packageName: String,
        val values: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> =
            values +
                    mapOf(
                            "title" to title,
                            "packageName" to packageName,
                    )
}

enum class GalleryMode {
    AUTO,
    MANUAL,
}

enum class ButtonMode(val value: String) {
    PHOTO("photo"),
    VIDEO("video"),
    NONE("none"),
}

enum class PhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large"),
}

data class ButtonPhotoSettings(
        val size: MentraPhotoSize,
)

data class ButtonVideoRecordingSettings(
        val width: Int,
        val height: Int,
        val fps: Int,
)

enum class CameraFov(val fov: Int, val roiPosition: Int) {
    STANDARD(118, 0),
    WIDE(118, 0),
}

data class MicConfig(
        val sendPcmData: Boolean,
        val sendTranscript: Boolean,
        val bypassVad: Boolean,
        val sendLc3Data: Boolean = false,
)

enum class MicPreference(val value: String) {
    AUTO("auto"),
    PHONE("phone"),
    GLASSES("glasses"),
    BT_CLASSIC("btclassic"),
    BT("bt"),
}

data class PhotoRequest(
        val requestId: String,
        val appId: String,
        val size: String,
        val webhookUrl: String,
        val authToken: String,
        val compress: String,
        val flash: Boolean,
        val sound: Boolean,
)

data class StreamRequest(
        val values: Map<String, Any>,
)

data class StreamKeepAliveRequest(
        val values: Map<String, Any>,
)

data class VideoRecordingRequest(
        val requestId: String,
        val save: Boolean,
        val flash: Boolean,
        val sound: Boolean,
)

data class ButtonPressEvent(
        val buttonId: String,
        val pressType: String,
        val timestamp: Long? = null,
)

data class TouchEvent(
        val values: Map<String, Any>,
)

data class BatteryStatusEvent(
        val level: Int?,
        val charging: Boolean?,
        val values: Map<String, Any>,
)

data class WifiStatusEvent(
        val values: Map<String, Any>,
)

data class GalleryStatusEvent(
        val values: Map<String, Any>,
)

data class PhotoResponseEvent(
        val values: Map<String, Any>,
)

data class StreamStatusEvent(
        val values: Map<String, Any>,
)

data class LocalTranscriptionEvent(
        val text: String,
        val isFinal: Boolean,
        val values: Map<String, Any>,
)

data class BluetoothError(
        val code: String,
        val message: String,
        val cause: Throwable? = null,
)

enum class ScanStopReason {
    COMPLETED,
    CANCELLED,
    ERROR,
}

interface BluetoothSdkListener {
    fun onGlassesStatusChanged(status: GlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: BluetoothStatusUpdate) {}
    fun onDeviceDiscovered(device: MentraDiscoveredDevice) {}
    fun onScanStopped(reason: ScanStopReason) {}
    fun onButtonPress(event: ButtonPressEvent) {}
    fun onTouch(event: TouchEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: BatteryStatusEvent) {}
    fun onWifiStatusChanged(event: WifiStatusEvent) {}
    fun onGalleryStatus(event: GalleryStatusEvent) {}
    fun onPhotoResponse(event: PhotoResponseEvent) {}
    fun onStreamStatus(event: StreamStatusEvent) {}
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
    fun onLocalTranscription(event: LocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: PairedDevice?) {}
    fun onLog(message: String) {}
    fun onError(error: BluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class BluetoothSdkCallback : BluetoothSdkListener
