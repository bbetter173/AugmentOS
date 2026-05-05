package com.mentra.core

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.mentra.core.utils.PhoneAudioMonitor
import java.util.Collections

class BluetoothSdk private constructor(
    context: Context,
    private val config: BluetoothSdkConfig,
    listener: BluetoothSdkListener,
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val deviceManager: CoreManager
    private val listeners =
        Collections.synchronizedSet(mutableSetOf<BluetoothSdkListener>())
    private val discoveredDeviceNames = mutableSetOf<String>()
    private val bridgeEventSinkId: String
    private val storeListenerId: String

    init {
        listeners.add(listener)
        Bridge.initialize(appContext)
        deviceManager = CoreManager.getInstance()
        bridgeEventSinkId = Bridge.addEventSink { eventName, data -> dispatchBridgeEvent(eventName, data) }
        storeListenerId = GlassesStore.store.addListener { category, changes -> dispatchStoreUpdate(category, changes) }
    }

    companion object {
        @JvmStatic
        fun create(
            context: Context,
            listener: BluetoothSdkListener,
        ): BluetoothSdk = create(context, BluetoothSdkConfig(), listener)

        @JvmStatic
        fun create(
            context: Context,
            config: BluetoothSdkConfig,
            listener: BluetoothSdkListener,
        ): BluetoothSdk = BluetoothSdk(context, config, listener)
    }

    fun addListener(listener: BluetoothSdkListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: BluetoothSdkListener) {
        listeners.remove(listener)
    }

    fun getGlassesStatus(): MentraGlassesStatus =
        MentraGlassesStatus(GlassesStore.store.getCategory("glasses"))

    fun getBluetoothStatus(): MentraBluetoothStatus =
        MentraBluetoothStatus(GlassesStore.store.getCategory(ObservableStore.CORE_CATEGORY))

    fun startScan(model: MentraDeviceModel) {
        discoveredDeviceNames.clear()
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "searching", true)
        deviceManager.findCompatibleDevices(model.deviceType)
    }

    fun stopScan() {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "searching", false)
        dispatchToListeners { it.onScanStopped(MentraScanStopReason.CANCELLED) }
    }

    fun connect(device: MentraDiscoveredDevice) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "pending_wearable", device.model.deviceType)
        deviceManager.connectByName(device.name)
    }

    fun connectByName(model: MentraDeviceModel, deviceName: String) {
        GlassesStore.apply(ObservableStore.CORE_CATEGORY, "pending_wearable", model.deviceType)
        deviceManager.connectByName(deviceName)
    }

    fun connectByName(deviceName: String) {
        deviceManager.connectByName(deviceName)
    }

    fun connectDefault() {
        deviceManager.connectDefault()
    }

    fun connectSimulated() {
        deviceManager.connectSimulated()
    }

    fun disconnect() {
        deviceManager.disconnect()
    }

    fun forget() {
        deviceManager.forget()
    }

    fun displayText(request: MentraDisplayTextRequest) {
        deviceManager.displayText(request.toMap())
    }

    fun displayEvent(request: MentraDisplayEventRequest) {
        deviceManager.displayEvent(request.toMap())
    }

    fun clearDisplay() {
        deviceManager.clearDisplay()
    }

    fun showDashboard() {
        deviceManager.showDashboard()
    }
    
    fun setOwnAppAudioPlaying(playing: Boolean) {
        PhoneAudioMonitor.getInstance(appContext).setOwnAppAudioPlaying(playing)
    }

    fun requestWifiScan() {
        deviceManager.requestWifiScan()
    }

    fun sendWifiCredentials(ssid: String, password: String) {
        deviceManager.sendWifiCredentials(ssid, password)
    }

    fun forgetWifiNetwork(ssid: String) {
        deviceManager.forgetWifiNetwork(ssid)
    }

    fun setHotspotState(enabled: Boolean) {
        deviceManager.setHotspotState(enabled)
    }

    fun requestPhoto(request: MentraPhotoRequest) {
        deviceManager.photoRequest(
            request.requestId,
            request.appId,
            request.size,
            request.webhookUrl,
            request.authToken,
            request.compress,
            request.flash,
            request.sound,
        )
    }

    fun queryGalleryStatus() {
        deviceManager.queryGalleryStatus()
    }

    fun startStream(request: MentraStreamRequest) {
        deviceManager.startStream(request.values.toMutableMap())
    }

    fun keepStreamAlive(request: MentraStreamKeepAliveRequest) {
        deviceManager.keepStreamAlive(request.values.toMutableMap())
    }

    fun stopStream() {
        deviceManager.stopStream()
    }

    fun startVideoRecording(request: MentraVideoRecordingRequest) {
        deviceManager.startVideoRecording(request.requestId, request.save, request.flash, request.sound)
    }

    fun stopVideoRecording(requestId: String) {
        deviceManager.stopVideoRecording(requestId)
    }

    fun requestVersionInfo() {
        deviceManager.requestVersionInfo()
    }

    fun sendOtaStart() {
        deviceManager.sendOtaStart()
    }

    fun sendShutdown() {
        deviceManager.sendShutdown()
    }

    fun sendReboot() {
        deviceManager.sendReboot()
    }

    fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null) {
        deviceManager.sendIncidentId(incidentId, apiBaseUrl)
    }

    override fun close() {
        Bridge.removeEventSink(bridgeEventSinkId)
        GlassesStore.store.removeListener(storeListenerId)
        listeners.clear()
    }

    private fun dispatchStoreUpdate(category: String, changes: Map<String, Any>) {
        when (ObservableStore.normalizeCategory(category)) {
            "glasses" ->
                dispatchToListeners {
                    it.onGlassesStatusChanged(MentraGlassesStatusUpdate(changes))
                }
            ObservableStore.CORE_CATEGORY -> {
                dispatchToListeners {
                    it.onBluetoothStatusChanged(MentraBluetoothStatusUpdate(changes))
                }
                dispatchDiscoveredDevices(changes["searchResults"])
            }
        }
    }

    private fun dispatchDiscoveredDevices(rawSearchResults: Any?) {
        val results = rawSearchResults as? List<*> ?: return
        results.forEach { rawResult ->
            val result = rawResult as? Map<*, *> ?: return@forEach
            val name = result["deviceName"] as? String ?: result["name"] as? String ?: return@forEach
            if (!discoveredDeviceNames.add(name)) return@forEach
            val model = MentraDeviceModel.fromDeviceType(result["deviceModel"] as? String)
            val device = MentraDiscoveredDevice(model = model, name = name)
            dispatchToListeners { it.onDeviceDiscovered(device) }
        }
    }

    private fun dispatchBridgeEvent(eventName: String, data: Map<String, Any>) {
        when (eventName) {
            "log" -> dispatchToListeners { it.onLog(data["message"] as? String ?: data.toString()) }
            "button_press" ->
                dispatchToListeners {
                    it.onButtonPress(
                        MentraButtonPressEvent(
                            buttonId = data["buttonId"] as? String ?: "",
                            pressType = data["pressType"] as? String ?: "",
                            timestamp = (data["timestamp"] as? Number)?.toLong(),
                        )
                    )
                }
            "touch_event" -> dispatchToListeners { it.onTouch(MentraTouchEvent(data)) }
            "head_up" -> dispatchToListeners { it.onHeadUpChanged(data["up"] as? Boolean ?: false) }
            "battery_status" ->
                dispatchToListeners {
                    it.onBatteryStatus(
                        MentraBatteryStatusEvent(
                            level = (data["level"] as? Number)?.toInt(),
                            charging = data["charging"] as? Boolean,
                            values = data,
                        )
                    )
                }
            "wifi_status_change" -> dispatchToListeners { it.onWifiStatusChanged(MentraWifiStatusEvent(data)) }
            "gallery_status" -> dispatchToListeners { it.onGalleryStatus(MentraGalleryStatusEvent(data)) }
            "photo_response" -> dispatchToListeners { it.onPhotoResponse(MentraPhotoResponseEvent(data)) }
            "stream_status" -> dispatchToListeners { it.onStreamStatus(MentraStreamStatusEvent(data)) }
            "mic_pcm" -> (data["pcm"] as? ByteArray)?.let { frame ->
                dispatchToListeners { it.onMicPcm(frame) }
            }
            "mic_lc3" -> (data["lc3"] as? ByteArray)?.let { frame ->
                dispatchToListeners { it.onMicLc3(frame) }
            }
            "local_transcription" ->
                dispatchToListeners {
                    it.onLocalTranscription(
                        MentraLocalTranscriptionEvent(
                            text = data["text"] as? String ?: "",
                            isFinal = data["isFinal"] as? Boolean ?: false,
                            values = data,
                        )
                    )
                }
            "compatible_glasses_search_stop" ->
                dispatchToListeners { it.onScanStopped(MentraScanStopReason.COMPLETED) }
            "pair_failure" ->
                dispatchToListeners {
                    it.onError(
                        MentraBluetoothError(
                            code = "pair_failure",
                            message = data["error"] as? String ?: data.toString(),
                        )
                    )
                }
            else -> dispatchToListeners { it.onRawEvent(eventName, data) }
        }
    }

    private fun dispatchToListeners(callback: (BluetoothSdkListener) -> Unit) {
        val snapshot = synchronized(listeners) { listeners.toList() }
        val deliver = {
            snapshot.forEach { listener ->
                try {
                    callback(listener)
                } catch (error: Throwable) {
                    // Listener exceptions should not crash Bluetooth event delivery.
                }
            }
        }
        if (config.deliverCallbacksOnMainThread && Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(deliver)
        } else {
            deliver()
        }
    }
}
