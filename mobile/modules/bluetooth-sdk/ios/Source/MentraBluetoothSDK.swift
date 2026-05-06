import Foundation

private func intValue(_ value: Any?) -> Int? {
    if let int = value as? Int { return int }
    if let double = value as? Double { return Int(double) }
    if let number = value as? NSNumber { return number.intValue }
    return nil
}

public struct MentraBluetoothSDKConfiguration {
    public static let `default` = MentraBluetoothSDKConfiguration()

    public init() {}
}

public enum MentraDeviceModel: String {
    case g1
    case g2
    case mentraLive
    case mentraNex
    case mach1
    case z100
    case frame
    case simulated
    case r1

    var deviceType: String {
        switch self {
        case .g1:
            DeviceTypes.G1
        case .g2:
            DeviceTypes.G2
        case .mentraLive:
            DeviceTypes.LIVE
        case .mentraNex:
            DeviceTypes.NEX
        case .mach1:
            DeviceTypes.MACH1
        case .z100:
            DeviceTypes.Z100
        case .frame:
            DeviceTypes.FRAME
        case .simulated:
            DeviceTypes.SIMULATED
        case .r1:
            ControllerTypes.R1
        }
    }

    static func fromDeviceType(_ deviceType: String?) -> MentraDeviceModel {
        switch deviceType {
        case DeviceTypes.G1:
            .g1
        case DeviceTypes.G2:
            .g2
        case DeviceTypes.LIVE:
            .mentraLive
        case DeviceTypes.NEX:
            .mentraNex
        case DeviceTypes.MACH1:
            .mach1
        case DeviceTypes.Z100:
            .z100
        case DeviceTypes.FRAME:
            .frame
        case DeviceTypes.SIMULATED:
            .simulated
        case ControllerTypes.R1:
            .r1
        default:
            .mentraLive
        }
    }
}

public struct MentraDiscoveredDevice: CustomStringConvertible {
    public let model: MentraDeviceModel
    public let name: String
    public let identifier: String?
    public let rssi: Int?

    public init(
        model: MentraDeviceModel,
        name: String,
        identifier: String? = nil,
        rssi: Int? = nil
    ) {
        self.model = model
        self.name = name
        self.identifier = identifier
        self.rssi = rssi
    }

    public var description: String {
        "MentraDiscoveredDevice(model: \(model), name: \(name))"
    }
}

public struct MentraPairedDevice: CustomStringConvertible {
    public let model: MentraDeviceModel
    public let name: String
    public let identifier: String?

    public init(model: MentraDeviceModel, name: String, identifier: String? = nil) {
        self.model = model
        self.name = name
        self.identifier = identifier
    }

    public var description: String {
        "MentraPairedDevice(model: \(model), name: \(name))"
    }
}

public struct MentraGlassesStatus: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var description: String {
        values.description
    }
}

public struct MentraBluetoothStatus: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var description: String {
        values.description
    }
}

public struct MentraGlassesStatusUpdate: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var description: String {
        values.description
    }
}

public struct MentraBluetoothStatusUpdate: CustomStringConvertible {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }

    public var description: String {
        values.description
    }
}

public struct MentraDisplayTextRequest {
    public let text: String
    public let x: Int
    public let y: Int
    public let size: Int

    public init(text: String, x: Int = 0, y: Int = 0, size: Int = 24) {
        self.text = text
        self.x = x
        self.y = y
        self.size = size
    }

    var dictionary: [String: Any] {
        [
            "text": text,
            "x": x,
            "y": y,
            "size": size,
        ]
    }
}

public struct MentraDisplayEventRequest {
    public let values: [String: Any]

    public init(values: [String: Any]) {
        self.values = values
    }
}

public struct MentraDashboardPositionRequest {
    public let height: Int
    public let depth: Int

    public init(height: Int, depth: Int) {
        self.height = height
        self.depth = depth
    }
}

public struct MentraDashboardMenuItem {
    public let title: String
    public let packageName: String
    public let values: [String: Any]

    public init(title: String, packageName: String, values: [String: Any] = [:]) {
        self.title = title
        self.packageName = packageName
        self.values = values
    }

    var dictionary: [String: Any] {
        values.merging(["title": title, "packageName": packageName]) { _, new in new }
    }
}

public enum MentraGalleryMode {
    case auto
    case manual
}

public enum MentraPhotoSize: String {
    case small
    case medium
    case large
    case full
}

public enum MentraButtonPhotoSize: String {
    case small
    case medium
    case large
}

public enum MentraPhotoCompression: String {
    case none
    case medium
    case heavy
}

public struct MentraButtonPhotoSettings {
    public let size: MentraButtonPhotoSize

    public init(size: MentraButtonPhotoSize) {
        self.size = size
    }
}

public struct MentraButtonVideoRecordingSettings {
    public let width: Int
    public let height: Int
    public let fps: Int

    public init(width: Int, height: Int, fps: Int) {
        self.width = width
        self.height = height
        self.fps = fps
    }
}

public enum MentraCameraFov {
    case standard
    case wide

    var value: [String: Int] {
        switch self {
        case .standard:
            ["fov": 118, "roi_position": 0]
        case .wide:
            ["fov": 118, "roi_position": 0]
        }
    }
}

public struct MentraMicConfiguration {
    public let sendPcmData: Bool
    public let sendTranscript: Bool
    public let bypassVad: Bool
    public let sendLc3Data: Bool

    public init(
        sendPcmData: Bool,
        sendTranscript: Bool,
        bypassVad: Bool,
        sendLc3Data: Bool = false
    ) {
        self.sendPcmData = sendPcmData
        self.sendTranscript = sendTranscript
        self.bypassVad = bypassVad
        self.sendLc3Data = sendLc3Data
    }
}

public enum MentraMicPreference: String {
    case auto
    case phone
    case glasses
    case bluetooth
}

public struct MentraPhotoRequest {
    public let requestId: String
    public let appId: String
    public let size: MentraPhotoSize
    public let webhookUrl: String?
    public let authToken: String?
    public let compress: MentraPhotoCompression?
    public let flash: Bool
    public let sound: Bool

    public init(
        requestId: String,
        appId: String,
        size: MentraPhotoSize,
        webhookUrl: String? = nil,
        authToken: String? = nil,
        compress: MentraPhotoCompression? = nil,
        flash: Bool,
        sound: Bool
    ) {
        self.requestId = requestId
        self.appId = appId
        self.size = size
        self.webhookUrl = webhookUrl
        self.authToken = authToken
        self.compress = compress
        self.flash = flash
        self.sound = sound
    }
}

public struct MentraStreamVideoConfig {
    public let width: Int?
    public let height: Int?
    public let bitrate: Int?
    public let frameRate: Int?

    public init(
        width: Int? = nil,
        height: Int? = nil,
        bitrate: Int? = nil,
        frameRate: Int? = nil
    ) {
        self.width = width
        self.height = height
        self.bitrate = bitrate
        self.frameRate = frameRate
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [:]
        if let width { values["width"] = width }
        if let height { values["height"] = height }
        if let bitrate { values["bitrate"] = bitrate }
        if let frameRate { values["frameRate"] = frameRate }
        return values
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            width: intValue(values["width"] ?? values["w"]),
            height: intValue(values["height"] ?? values["h"]),
            bitrate: intValue(values["bitrate"] ?? values["br"]),
            frameRate: intValue(values["frameRate"] ?? values["fr"])
        )
    }
}

public struct MentraStreamAudioConfig {
    public let bitrate: Int?
    public let sampleRate: Int?
    public let echoCancellation: Bool?
    public let noiseSuppression: Bool?

    public init(
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        echoCancellation: Bool? = nil,
        noiseSuppression: Bool? = nil
    ) {
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.echoCancellation = echoCancellation
        self.noiseSuppression = noiseSuppression
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [:]
        if let bitrate { values["bitrate"] = bitrate }
        if let sampleRate { values["sampleRate"] = sampleRate }
        if let echoCancellation { values["echoCancellation"] = echoCancellation }
        if let noiseSuppression { values["noiseSuppression"] = noiseSuppression }
        return values
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            bitrate: intValue(values["bitrate"] ?? values["br"]),
            sampleRate: intValue(values["sampleRate"] ?? values["sr"]),
            echoCancellation: values["echoCancellation"] as? Bool ?? values["ec"] as? Bool,
            noiseSuppression: values["noiseSuppression"] as? Bool ?? values["ns"] as? Bool
        )
    }
}

public struct MentraStreamRequest {
    public let streamUrl: String
    public let streamId: String
    public let keepAlive: Bool
    public let keepAliveIntervalSeconds: Int
    public let flash: Bool
    public let sound: Bool
    public let video: MentraStreamVideoConfig?
    public let audio: MentraStreamAudioConfig?
    public let extraValues: [String: Any]

    public init(
        streamUrl: String,
        streamId: String = "",
        keepAlive: Bool = true,
        keepAliveIntervalSeconds: Int = 15,
        flash: Bool = true,
        sound: Bool = true,
        video: MentraStreamVideoConfig? = nil,
        audio: MentraStreamAudioConfig? = nil,
        extraValues: [String: Any] = [:]
    ) {
        self.streamUrl = streamUrl
        self.streamId = streamId
        self.keepAlive = keepAlive
        self.keepAliveIntervalSeconds = keepAliveIntervalSeconds
        self.flash = flash
        self.sound = sound
        self.video = video
        self.audio = audio
        self.extraValues = extraValues
    }

    init(values: [String: Any]) {
        self.init(
            streamUrl: values["streamUrl"] as? String
                ?? values["rtmpUrl"] as? String
                ?? values["srtUrl"] as? String
                ?? values["whipUrl"] as? String
                ?? "",
            streamId: values["streamId"] as? String ?? "",
            keepAlive: values["keepAlive"] as? Bool ?? true,
            keepAliveIntervalSeconds: intValue(values["keepAliveIntervalSeconds"]) ?? 15,
            flash: values["flash"] as? Bool ?? true,
            sound: values["sound"] as? Bool ?? true,
            video: MentraStreamVideoConfig(values: (values["video"] ?? values["v"]) as? [String: Any]),
            audio: MentraStreamAudioConfig(values: (values["audio"] ?? values["a"]) as? [String: Any]),
            extraValues: values
        )
    }

    public var values: [String: Any] {
        var values = extraValues
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["keepAlive"] = keepAlive
        values["keepAliveIntervalSeconds"] = keepAliveIntervalSeconds
        values["flash"] = flash
        values["sound"] = sound
        if let videoValues = video?.dictionary, !videoValues.isEmpty {
            values["video"] = videoValues
        }
        if let audioValues = audio?.dictionary, !audioValues.isEmpty {
            values["audio"] = audioValues
        }
        return values
    }
}

public struct MentraStreamKeepAliveRequest {
    public let streamId: String
    public let ackId: String
    public let extraValues: [String: Any]

    public init(streamId: String, ackId: String, extraValues: [String: Any] = [:]) {
        self.streamId = streamId
        self.ackId = ackId
        self.extraValues = extraValues
    }

    init(values: [String: Any]) {
        self.init(
            streamId: values["streamId"] as? String ?? "",
            ackId: values["ackId"] as? String ?? "",
            extraValues: values
        )
    }

    public var values: [String: Any] {
        var values = extraValues
        values["type"] = "keep_stream_alive"
        values["streamId"] = streamId
        values["ackId"] = ackId
        return values
    }
}

public enum MentraRgbLedAction: String {
    case on
    case off
}

public enum MentraRgbLedColor: String {
    case red
    case green
    case blue
    case orange
    case white
}

public struct MentraRgbLedRequest {
    public let requestId: String
    public let packageName: String?
    public let action: MentraRgbLedAction
    public let color: MentraRgbLedColor?
    public let ontime: Int
    public let offtime: Int
    public let count: Int

    public init(
        requestId: String,
        packageName: String?,
        action: MentraRgbLedAction,
        color: MentraRgbLedColor?,
        ontime: Int,
        offtime: Int,
        count: Int
    ) {
        self.requestId = requestId
        self.packageName = packageName
        self.action = action
        self.color = color
        self.ontime = ontime
        self.offtime = offtime
        self.count = count
    }
}

public struct MentraVideoRecordingRequest {
    public let requestId: String
    public let save: Bool
    public let flash: Bool
    public let sound: Bool

    public init(requestId: String, save: Bool, flash: Bool, sound: Bool) {
        self.requestId = requestId
        self.save = save
        self.flash = flash
        self.sound = sound
    }
}

public struct MentraButtonPressEvent: CustomStringConvertible {
    public let buttonId: String
    public let pressType: String
    public let timestamp: Int?

    public init(buttonId: String, pressType: String, timestamp: Int? = nil) {
        self.buttonId = buttonId
        self.pressType = pressType
        self.timestamp = timestamp
    }

    public var description: String {
        "MentraButtonPressEvent(buttonId: \(buttonId), pressType: \(pressType))"
    }
}

public struct MentraBluetoothError: Error, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String {
        "\(code): \(message)"
    }
}

public enum MentraScanStopReason {
    case completed
    case cancelled
    case error
}

public struct MentraLocalTranscriptionEvent: CustomStringConvertible {
    public let text: String
    public let isFinal: Bool
    public let values: [String: Any]

    public init(text: String, isFinal: Bool, values: [String: Any]) {
        self.text = text
        self.isFinal = isFinal
        self.values = values
    }

    public var description: String {
        "MentraLocalTranscriptionEvent(text: \(text), isFinal: \(isFinal))"
    }
}

public enum MentraBluetoothEvent: CustomStringConvertible {
    case localTranscription(MentraLocalTranscriptionEvent)
    case raw(name: String, values: [String: Any])

    public var description: String {
        switch self {
        case let .localTranscription(event):
            event.description
        case let .raw(name, values):
            "\(name): \(values)"
        }
    }
}

@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: MentraDiscoveredDevice)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: MentraScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: MentraPairedDevice?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: MentraBluetoothError)
}

@MainActor
public extension MentraBluetoothSDKDelegate {
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlassesStatus _: MentraGlassesStatusUpdate) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateBluetoothStatus _: MentraBluetoothStatusUpdate) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didDiscover _: MentraDiscoveredDevice) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didStopScan _: MentraScanStopReason) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive _: MentraBluetoothEvent) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicPcm _: Data) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceiveMicLc3 _: Data) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: MentraPairedDevice?) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didLog _: String) {}
    func mentraBluetoothSDK(_: MentraBluetoothSDK, didFail _: MentraBluetoothError) {}
}

@MainActor
public final class MentraBluetoothSDK {
    public weak var delegate: MentraBluetoothSDKDelegate?

    private let configuration: MentraBluetoothSDKConfiguration
    private var discoveredDeviceNames = Set<String>()
    private var bridgeEventSinkId: String?
    private var storeListenerId: String?

    public init(configuration: MentraBluetoothSDKConfiguration = .default) {
        self.configuration = configuration
        bridgeEventSinkId = Bridge.addEventSink { [weak self] eventName, data in
            Task { @MainActor [weak self] in
                self?.dispatchBridgeEvent(eventName, data)
            }
        }
        storeListenerId = GlassesStore.shared.store.addListener { [weak self] category, changes in
            self?.dispatchStoreUpdate(category, changes)
        }
    }

    public var glassesStatus: MentraGlassesStatus {
        MentraGlassesStatus(values: GlassesStore.shared.store.getCategory("glasses"))
    }

    public var bluetoothStatus: MentraBluetoothStatus {
        MentraBluetoothStatus(values: GlassesStore.shared.store.getCategory(ObservableStore.coreCategory))
    }

    public func startScan(model: MentraDeviceModel) {
        discoveredDeviceNames.removeAll()
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", true)
        CoreManager.shared.findCompatibleDevices(model.deviceType)
    }

    public func stopScan() {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", false)
        delegate?.mentraBluetoothSDK(self, didStopScan: .cancelled)
    }

    public func connect(to device: MentraDiscoveredDevice) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "pending_wearable", device.model.deviceType)
        CoreManager.shared.connectByName(device.name)
    }

    public func connect(model: MentraDeviceModel, name: String) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "pending_wearable", model.deviceType)
        CoreManager.shared.connectByName(name)
    }

    public func connectByName(_ name: String) {
        CoreManager.shared.connectByName(name)
    }

    public func connectDefault() {
        CoreManager.shared.connectDefault()
    }

    public func connectSimulated() {
        CoreManager.shared.connectSimulated()
    }

    public func disconnect() {
        CoreManager.shared.disconnect()
    }

    public func forget() {
        CoreManager.shared.forget()
    }

    public func displayText(_ request: MentraDisplayTextRequest) async throws {
        CoreManager.shared.displayText(request.dictionary)
    }

    public func displayEvent(_ request: MentraDisplayEventRequest) async throws {
        CoreManager.shared.displayEvent(request.values)
    }

    public func clearDisplay() async throws {
        CoreManager.shared.sgc?.clearDisplay()
    }

    public func showDashboard() {
        CoreManager.shared.showDashboard()
    }

    public func setBrightness(_ level: Int, autoMode: Bool? = nil) async throws {
        if let autoMode {
            GlassesStore.shared.apply(ObservableStore.coreCategory, "auto_brightness", autoMode)
        }
        GlassesStore.shared.apply(ObservableStore.coreCategory, "brightness", level)
    }

    public func setAutoBrightness(enabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "auto_brightness", enabled)
    }

    public func setDashboardPosition(_ request: MentraDashboardPositionRequest) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_height", request.height)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "dashboard_depth", request.depth)
    }

    public func setDashboardMenu(_ items: [MentraDashboardMenuItem]) async throws {
        GlassesStore.shared.apply(
            ObservableStore.coreCategory,
            "dashboard_menu_apps",
            items.map(\.dictionary)
        )
    }

    public func setHeadUpAngle(_ angleDegrees: Int) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "head_up_angle", angleDegrees)
    }

    public func setScreenDisabled(_ disabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "screen_disabled", disabled)
    }

    public func setGalleryMode(_ mode: MentraGalleryMode) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "gallery_mode", mode == .auto)
    }

    public func setButtonPhotoSettings(_ settings: MentraButtonPhotoSettings) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_photo_size", settings.size.rawValue)
    }

    public func setButtonVideoRecordingSettings(_ settings: MentraButtonVideoRecordingSettings) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_width", settings.width)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_height", settings.height)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_video_fps", settings.fps)
    }

    public func setButtonCameraLed(enabled: Bool) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_camera_led", enabled)
    }

    public func setButtonMaxRecordingTime(minutes: Int) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "button_max_recording_time", minutes)
    }

    public func setCameraFov(_ fov: MentraCameraFov) async throws {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "camera_fov", fov.value)
    }

    public func setMicState(_ config: MentraMicConfiguration) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_pcm", config.sendPcmData)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_lc3", config.sendLc3Data)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "should_send_transcript", config.sendTranscript)
        GlassesStore.shared.apply(ObservableStore.coreCategory, "bypass_vad", config.bypassVad)
        CoreManager.shared.setMicState()
    }

    public func setPreferredMic(_ preferredMic: MentraMicPreference) {
        GlassesStore.shared.apply(ObservableStore.coreCategory, "preferred_mic", preferredMic.rawValue)
    }

    public func setOwnAppAudioPlaying(_ playing: Bool) {
        PhoneAudioMonitor.getInstance().setOwnAppAudioPlaying(playing)
    }

    public func requestWifiScan() {
        CoreManager.shared.requestWifiScan()
    }

    public func sendWifiCredentials(ssid: String, password: String) {
        CoreManager.shared.sendWifiCredentials(ssid, password)
    }

    public func forgetWifiNetwork(ssid: String) {
        CoreManager.shared.forgetWifiNetwork(ssid)
    }

    public func setHotspotState(enabled: Bool) {
        CoreManager.shared.setHotspotState(enabled)
    }

    public func requestPhoto(_ request: MentraPhotoRequest) {
        CoreManager.shared.photoRequest(
            request.requestId,
            request.appId,
            request.size.rawValue,
            request.webhookUrl,
            request.authToken,
            request.compress?.rawValue,
            request.flash,
            request.sound
        )
    }

    public func queryGalleryStatus() {
        CoreManager.shared.queryGalleryStatus()
    }

    public func startStream(_ request: MentraStreamRequest) {
        CoreManager.shared.startStream(request.values)
    }

    public func keepStreamAlive(_ request: MentraStreamKeepAliveRequest) {
        CoreManager.shared.keepStreamAlive(request.values)
    }

    public func rgbLedControl(_ request: MentraRgbLedRequest) {
        CoreManager.shared.rgbLedControl(
            requestId: request.requestId,
            packageName: request.packageName,
            action: request.action.rawValue,
            color: request.color?.rawValue,
            ontime: request.ontime,
            offtime: request.offtime,
            count: request.count
        )
    }

    public func stopStream() {
        CoreManager.shared.stopStream()
    }

    public func startVideoRecording(_ request: MentraVideoRecordingRequest) {
        CoreManager.shared.startVideoRecording(
            request.requestId,
            request.save,
            request.flash,
            request.sound
        )
    }

    public func stopVideoRecording(requestId: String) {
        CoreManager.shared.stopVideoRecording(requestId)
    }

    public func requestVersionInfo() {
        CoreManager.shared.requestVersionInfo()
    }

    public func sendOtaStart() {
        CoreManager.shared.sendOtaStart()
    }

    public func sendShutdown() {
        CoreManager.shared.sendShutdown()
    }

    public func sendReboot() {
        CoreManager.shared.sendReboot()
    }

    public func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil) {
        CoreManager.shared.sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
    }

    public func invalidate() {
        if let bridgeEventSinkId {
            Bridge.removeEventSink(bridgeEventSinkId)
            self.bridgeEventSinkId = nil
        }
        if let storeListenerId {
            GlassesStore.shared.store.removeListener(storeListenerId)
            self.storeListenerId = nil
        }
        delegate = nil
    }

    private func dispatchStoreUpdate(_ category: String, _ changes: [String: Any]) {
        switch ObservableStore.normalizeCategory(category) {
        case "glasses":
            delegate?.mentraBluetoothSDK(self, didUpdateGlassesStatus: MentraGlassesStatusUpdate(values: changes))
        case ObservableStore.coreCategory:
            delegate?.mentraBluetoothSDK(self, didUpdateBluetoothStatus: MentraBluetoothStatusUpdate(values: changes))
            dispatchDiscoveredDevices(changes["searchResults"])
        default:
            break
        }
    }

    private func dispatchDiscoveredDevices(_ rawSearchResults: Any?) {
        guard let results = rawSearchResults as? [[String: Any]] else { return }
        for result in results {
            guard let name = result["deviceName"] as? String ?? result["name"] as? String else { continue }
            guard discoveredDeviceNames.insert(name).inserted else { continue }
            let model = MentraDeviceModel.fromDeviceType(result["deviceModel"] as? String)
            let device = MentraDiscoveredDevice(model: model, name: name)
            delegate?.mentraBluetoothSDK(self, didDiscover: device)
        }
    }

    private func dispatchBridgeEvent(_ eventName: String, _ data: [String: Any]) {
        switch eventName {
        case "log":
            delegate?.mentraBluetoothSDK(self, didLog: data["message"] as? String ?? data.description)
        case "mic_pcm":
            if let frame = data["pcm"] as? Data {
                delegate?.mentraBluetoothSDK(self, didReceiveMicPcm: frame)
            }
        case "mic_lc3":
            if let frame = data["lc3"] as? Data {
                delegate?.mentraBluetoothSDK(self, didReceiveMicLc3: frame)
            }
        case "local_transcription":
            let event = MentraLocalTranscriptionEvent(
                text: data["text"] as? String ?? "",
                isFinal: data["isFinal"] as? Bool ?? false,
                values: data
            )
            delegate?.mentraBluetoothSDK(self, didReceive: .localTranscription(event))
        case "compatible_glasses_search_stop":
            delegate?.mentraBluetoothSDK(self, didStopScan: .completed)
        case "pair_failure":
            delegate?.mentraBluetoothSDK(
                self,
                didFail: MentraBluetoothError(
                    code: "pair_failure",
                    message: data["error"] as? String ?? data.description
                )
            )
        default:
            delegate?.mentraBluetoothSDK(self, didReceive: .raw(name: eventName, values: data))
        }
    }
}
