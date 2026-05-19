import Foundation

public struct WifiScanResult: CustomStringConvertible {
    public let ssid: String
    public let requiresPassword: Bool
    public let signalStrength: Int
    public let frequency: Int?

    public init(ssid: String, requiresPassword: Bool, signalStrength: Int, frequency: Int? = nil) {
        self.ssid = ssid
        self.requiresPassword = requiresPassword
        self.signalStrength = signalStrength
        self.frequency = frequency
    }

    init(values: [String: Any]) {
        ssid = stringValue(values, "ssid") ?? ""
        requiresPassword = boolValue(values, "requiresPassword") ?? false
        signalStrength = intValue(values["signalStrength"]) ?? -1
        frequency = intValue(values["frequency"])
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [
            "ssid": ssid,
            "requiresPassword": requiresPassword,
            "signalStrength": signalStrength,
        ]
        if let frequency {
            values["frequency"] = frequency
        }
        return values
    }

    public var description: String {
        "WifiScanResult(ssid: \(ssid), signalStrength: \(signalStrength))"
    }
}

public enum GlassesConnectionState: String, CustomStringConvertible, Equatable {
    case disconnected = "DISCONNECTED"
    case scanning = "SCANNING"
    case connecting = "CONNECTING"
    case bonding = "BONDING"
    case connected = "CONNECTED"

    public init(_ value: String?) {
        self = Self.fromValue(value) ?? .disconnected
    }

    public static func fromValue(_ value: String?) -> GlassesConnectionState? {
        guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
              !normalized.isEmpty
        else {
            return nil
        }
        return Self(rawValue: normalized)
    }

    public var isConnected: Bool {
        self == .connected
    }

    public var isBusy: Bool {
        self == .scanning || self == .connecting || self == .bonding
    }

    func statusValues(connected: Bool, fullyBooted: Bool) -> [String: Any] {
        if self == .connected || connected || fullyBooted {
            return ["state": "connected", "fullyBooted": fullyBooted]
        }
        switch self {
        case .scanning:
            return ["state": "scanning"]
        case .connecting:
            return ["state": "connecting"]
        case .bonding:
            return ["state": "bonding"]
        case .connected:
            return ["state": "connected", "fullyBooted": fullyBooted]
        case .disconnected:
            return ["state": "disconnected"]
        }
    }

    public var description: String {
        rawValue
    }
}

public struct GlassesStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = values
    }

    public func applying(_ update: GlassesStatusUpdate) -> GlassesStatus {
        GlassesStatus(values: values.merging(update.values) { _, new in new })
    }

    public func withBattery(level: Int, charging: Bool) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: ["batteryLevel": level, "charging": charging]))
    }

    public func withWifi(_ wifi: WifiStatus) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: wifi.storeValues))
    }

    public func withHotspot(_ hotspot: HotspotStatus) -> GlassesStatus {
        applying(GlassesStatusUpdate(values: hotspot.storeValues))
    }

    public func disconnected() -> GlassesStatus {
        applying(GlassesStatusUpdate(values: [
            "connected": false,
            "connectionState": "DISCONNECTED",
            "fullyBooted": false,
            "batteryLevel": -1,
            "charging": false,
            "hotspotEnabled": false,
            "hotspotGatewayIp": "",
            "hotspotPassword": "",
            "hotspotSsid": "",
            "wifiConnected": false,
            "wifiSsid": "",
            "wifiLocalIp": "",
            "signalStrength": -1,
            "signalStrengthUpdatedAt": 0,
        ]))
    }

    public var fullyBooted: Bool { boolValue(values, "fullyBooted") ?? false }
    public var connected: Bool { boolValue(values, "connected") ?? false }
    public var micEnabled: Bool { boolValue(values, "micEnabled") ?? false }
    public var connectionState: GlassesConnectionState { GlassesConnectionState(stringValue(values, "connectionState")) }
    public var bluetoothClassicConnected: Bool { boolValue(values, "bluetoothClassicConnected") ?? false }
    public var signalStrength: Int { intValue(values["signalStrength"]) ?? -1 }
    public var signalStrengthUpdatedAt: Int { intValue(values["signalStrengthUpdatedAt"]) ?? 0 }
    public var deviceModel: String { stringValue(values, "deviceModel") ?? "" }
    public var androidVersion: String { stringValue(values, "androidVersion") ?? "" }
    public var firmwareVersion: String { stringValue(values, "firmwareVersion") ?? "" }
    public var besFirmwareVersion: String { stringValue(values, "besFirmwareVersion") ?? "" }
    public var mtkFirmwareVersion: String { stringValue(values, "mtkFirmwareVersion") ?? "" }
    public var bluetoothMacAddress: String { stringValue(values, "bluetoothMacAddress") ?? "" }
    public var leftMacAddress: String { stringValue(values, "leftMacAddress") ?? "" }
    public var rightMacAddress: String { stringValue(values, "rightMacAddress") ?? "" }
    public var macAddress: String { stringValue(values, "macAddress") ?? "" }
    public var buildNumber: String { stringValue(values, "buildNumber") ?? "" }
    public var otaVersionUrl: String { stringValue(values, "otaVersionUrl") ?? "" }
    public var appVersion: String { stringValue(values, "appVersion") ?? "" }
    public var bluetoothName: String { stringValue(values, "bluetoothName") ?? "" }
    public var serialNumber: String { stringValue(values, "serialNumber") ?? "" }
    public var style: String { stringValue(values, "style") ?? "" }
    public var color: String { stringValue(values, "color") ?? "" }
    public var wifi: WifiStatus { WifiStatus.fromStoreValues(values) ?? .disconnected }
    public var hotspot: HotspotStatus { HotspotStatus.fromStoreValues(values) ?? .disabled }
    public var dictionary: [String: Any] { Self.dictionary(from: values) }
    public var batteryLevel: Int { intValue(values["batteryLevel"]) ?? -1 }
    public var charging: Bool { boolValue(values, "charging") ?? false }
    public var caseBatteryLevel: Int { intValue(values["caseBatteryLevel"]) ?? -1 }
    public var caseCharging: Bool { boolValue(values, "caseCharging") ?? false }
    public var caseOpen: Bool { boolValue(values, "caseOpen") ?? true }
    public var caseRemoved: Bool { boolValue(values, "caseRemoved") ?? true }
    public var headUp: Bool { boolValue(values, "headUp") ?? false }
    public var controllerConnected: Bool { boolValue(values, "controllerConnected") ?? false }
    public var controllerFullyBooted: Bool { boolValue(values, "controllerFullyBooted") ?? false }
    public var controllerMacAddress: String { stringValue(values, "controllerMacAddress") ?? "" }
    public var controllerBatteryLevel: Int { intValue(values["controllerBatteryLevel"]) ?? -1 }
    public var controllerSignalStrength: Int { intValue(values["controllerSignalStrength"]) ?? -1 }
    public var ringSignalStrength: Int { intValue(values["ringSignalStrength"]) ?? -1 }

    public var description: String {
        values.description
    }

    static func dictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
        dictionary["connection"] = GlassesConnectionState(stringValue(values, "connectionState")).statusValues(
            connected: boolValue(values, "connected") ?? false,
            fullyBooted: boolValue(values, "fullyBooted") ?? false
        )
        dictionary.removeValue(forKey: "connected")
        dictionary.removeValue(forKey: "fullyBooted")
        dictionary.removeValue(forKey: "connectionState")
        dictionary["wifi"] = (WifiStatus.fromStoreValues(values) ?? .disconnected).values
        dictionary["hotspot"] = (HotspotStatus.fromStoreValues(values) ?? .disabled).values
        dictionary.removeValue(forKey: "wifiConnected")
        dictionary.removeValue(forKey: "wifiSsid")
        dictionary.removeValue(forKey: "wifiLocalIp")
        dictionary.removeValue(forKey: "hotspotEnabled")
        dictionary.removeValue(forKey: "hotspotSsid")
        dictionary.removeValue(forKey: "hotspotPassword")
        dictionary.removeValue(forKey: "hotspotGatewayIp")
        return dictionary
    }

    static func updateDictionary(from values: [String: Any]) -> [String: Any] {
        var dictionary = values
        if hasAnyKey(values, "connection", "connected", "fullyBooted", "connectionState") {
            dictionary["connection"] = (values["connection"] as? [String: Any])
                ?? GlassesConnectionState(stringValue(values, "connectionState")).statusValues(
                    connected: boolValue(values, "connected") ?? false,
                    fullyBooted: boolValue(values, "fullyBooted") ?? false
                )
            dictionary.removeValue(forKey: "connected")
            dictionary.removeValue(forKey: "fullyBooted")
            dictionary.removeValue(forKey: "connectionState")
        }
        if hasAnyKey(values, "wifi", "wifiConnected", "wifiSsid", "wifiLocalIp") {
            let wifi = (values["wifi"] as? [String: Any]).flatMap(WifiStatus.init(values:))
                ?? WifiStatus.fromStoreValues(values)
            if let wifi {
                dictionary["wifi"] = wifi.values
            }
            dictionary.removeValue(forKey: "wifiConnected")
            dictionary.removeValue(forKey: "wifiSsid")
            dictionary.removeValue(forKey: "wifiLocalIp")
        }
        if hasAnyKey(values, "hotspot") {
            if let hotspot = (values["hotspot"] as? [String: Any]).flatMap(HotspotStatus.init(values:)) {
                dictionary["hotspot"] = hotspot.values
            }
        } else if hasAnyKey(values, "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp") {
            if let hotspot = HotspotStatus.fromStoreValues(values) {
                dictionary["hotspot"] = hotspot.values
            }
            dictionary.removeValue(forKey: "hotspotEnabled")
            dictionary.removeValue(forKey: "hotspotSsid")
            dictionary.removeValue(forKey: "hotspotPassword")
            dictionary.removeValue(forKey: "hotspotGatewayIp")
        }
        return dictionary
    }
}

public struct BluetoothStatus: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = Self.normalized(values)
    }

    private static func normalized(_ values: [String: Any]) -> [String: Any] {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { Device(values: $0)?.dictionary }
        }
        return normalizedValues
    }

    public func applying(_ update: BluetoothStatusUpdate) -> BluetoothStatus {
        BluetoothStatus(values: values.merging(update.values) { _, new in new })
    }

    public func withDefaultDevice(_ device: Device?) -> BluetoothStatus {
        applying(BluetoothStatusUpdate(values: [
            "default_wearable": device?.model.deviceType ?? "",
            "device_name": device?.name ?? "",
            "device_address": device?.identifier ?? "",
        ]))
    }

    public var searching: Bool { boolValue(values, "searching") ?? false }
    public var searchingController: Bool { boolValue(values, "searchingController") ?? false }
    public var systemMicUnavailable: Bool { boolValue(values, "systemMicUnavailable") ?? false }
    public var micEnabled: Bool { boolValue(values, "micEnabled") ?? false }
    public var currentMic: String { stringValue(values, "currentMic") ?? "" }
    public var micRanking: [String] { stringListValue(values, "micRanking") }
    /// Nearby glasses in stable discovery order. Existing entries keep their array position as
    /// details refresh; new glasses append at the end, and removals should not reorder remaining entries.
    public var searchResults: [Device] {
        dictionaryListValue(values, "searchResults").compactMap(Device.init(values:))
    }
    public var wifiScanResults: [WifiScanResult] {
        dictionaryListValue(values, "wifiScanResults").map(WifiScanResult.init(values:))
    }
    public var lastLog: [String] { stringListValue(values, "lastLog") }
    public var otherBtConnected: Bool { boolValue(values, "otherBtConnected") ?? false }
    public var defaultWearable: String { stringValue(values, "default_wearable") ?? "" }
    public var pendingWearable: String { stringValue(values, "pending_wearable") ?? "" }
    public var deviceName: String { stringValue(values, "device_name") ?? "" }
    public var deviceAddress: String { stringValue(values, "device_address") ?? "" }
    public var defaultController: String { stringValue(values, "default_controller") ?? "" }
    public var pendingController: String { stringValue(values, "pending_controller") ?? "" }
    public var controllerDeviceName: String { stringValue(values, "controller_device_name") ?? "" }
    public var screenDisabled: Bool { boolValue(values, "screen_disabled") ?? false }
    public var preferredMic: String { stringValue(values, "preferred_mic") ?? "auto" }
    public var sensingEnabled: Bool { boolValue(values, "sensing_enabled") ?? true }
    public var powerSavingMode: Bool { boolValue(values, "power_saving_mode") ?? false }
    public var brightness: Int { intValue(values["brightness"]) ?? 50 }
    public var autoBrightness: Bool { boolValue(values, "auto_brightness") ?? true }
    public var dashboardHeight: Int { intValue(values["dashboard_height"]) ?? 4 }
    public var dashboardDepth: Int { intValue(values["dashboard_depth"]) ?? 2 }
    public var headUpAngle: Int { intValue(values["head_up_angle"]) ?? 30 }
    public var contextualDashboard: Bool { boolValue(values, "contextual_dashboard") ?? true }
    public var galleryModeAuto: Bool { boolValue(values, "galleryModeAuto") ?? true }
    public var buttonPhotoSize: ButtonPhotoSize {
        ButtonPhotoSize(rawValue: stringValue(values, "button_photo_size") ?? "") ?? .medium
    }
    public var buttonCameraLed: Bool { boolValue(values, "button_camera_led") ?? true }
    public var buttonMaxRecordingTime: Int { intValue(values["button_max_recording_time"]) ?? 10 }
    public var buttonVideoWidth: Int { intValue(values["button_video_width"]) ?? 1280 }
    public var buttonVideoHeight: Int { intValue(values["button_video_height"]) ?? 720 }
    public var buttonVideoFrameRate: Int { intValue(values["button_video_fps"]) ?? 30 }
    public var shouldSendPcm: Bool { boolValue(values, "should_send_pcm") ?? false }
    public var shouldSendLc3: Bool { boolValue(values, "should_send_lc3") ?? false }
    public var shouldSendTranscript: Bool { boolValue(values, "should_send_transcript") ?? false }
    public var bypassVad: Bool { boolValue(values, "bypass_vad") ?? true }
    public var offlineCaptionsRunning: Bool { boolValue(values, "offline_captions_running") ?? false }
    public var localSttFallbackActive: Bool { boolValue(values, "local_stt_fallback_active") ?? false }
    public var shouldSendBootingMessage: Bool { boolValue(values, "shouldSendBootingMessage") ?? true }

    public var defaultDevice: Device? {
        guard !defaultWearable.isEmpty else { return nil }
        return Device(
            model: DeviceModel.fromDeviceType(defaultWearable),
            name: deviceName,
            identifier: deviceAddress.isEmpty ? nil : deviceAddress
        )
    }

    public var description: String {
        values.description
    }
}

public struct GlassesStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        self.values = values
    }

    public var fullyBooted: Bool? { optionalBoolValue(values, "fullyBooted") }
    public var connected: Bool? { optionalBoolValue(values, "connected") }
    public var micEnabled: Bool? { optionalBoolValue(values, "micEnabled") }
    public var connectionState: GlassesConnectionState? {
        GlassesConnectionState.fromValue(optionalStringValue(values, "connectionState"))
    }
    public var bluetoothClassicConnected: Bool? { optionalBoolValue(values, "bluetoothClassicConnected") }
    public var signalStrength: Int? { optionalIntValue(values, "signalStrength") }
    public var signalStrengthUpdatedAt: Int? { optionalIntValue(values, "signalStrengthUpdatedAt") }
    public var deviceModel: String? { optionalStringValue(values, "deviceModel") }
    public var androidVersion: String? { optionalStringValue(values, "androidVersion") }
    public var firmwareVersion: String? { optionalStringValue(values, "firmwareVersion") }
    public var besFirmwareVersion: String? { optionalStringValue(values, "besFirmwareVersion") }
    public var mtkFirmwareVersion: String? { optionalStringValue(values, "mtkFirmwareVersion") }
    public var bluetoothMacAddress: String? { optionalStringValue(values, "bluetoothMacAddress") }
    public var leftMacAddress: String? { optionalStringValue(values, "leftMacAddress") }
    public var rightMacAddress: String? { optionalStringValue(values, "rightMacAddress") }
    public var macAddress: String? { optionalStringValue(values, "macAddress") }
    public var buildNumber: String? { optionalStringValue(values, "buildNumber") }
    public var otaVersionUrl: String? { optionalStringValue(values, "otaVersionUrl") }
    public var appVersion: String? { optionalStringValue(values, "appVersion") }
    public var bluetoothName: String? { optionalStringValue(values, "bluetoothName") }
    public var serialNumber: String? { optionalStringValue(values, "serialNumber") }
    public var style: String? { optionalStringValue(values, "style") }
    public var color: String? { optionalStringValue(values, "color") }
    public var wifi: WifiStatus? {
        if let wifi = values["wifi"] as? [String: Any] {
            return WifiStatus(values: wifi)
        }
        if hasAnyKey(values, "wifiConnected", "wifiSsid", "wifiLocalIp") {
            return WifiStatus.fromStoreValues(values)
        }
        return nil
    }
    public var hotspot: HotspotStatus? {
        if let hotspot = values["hotspot"] as? [String: Any] {
            return HotspotStatus(values: hotspot)
        }
        if hasAnyKey(values, "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp") {
            return HotspotStatus.fromStoreValues(values)
        }
        return nil
    }
    public var dictionary: [String: Any] { GlassesStatus.updateDictionary(from: values) }
    public var batteryLevel: Int? { optionalIntValue(values, "batteryLevel") }
    public var charging: Bool? { optionalBoolValue(values, "charging") }
    public var caseBatteryLevel: Int? { optionalIntValue(values, "caseBatteryLevel") }
    public var caseCharging: Bool? { optionalBoolValue(values, "caseCharging") }
    public var caseOpen: Bool? { optionalBoolValue(values, "caseOpen") }
    public var caseRemoved: Bool? { optionalBoolValue(values, "caseRemoved") }
    public var headUp: Bool? { optionalBoolValue(values, "headUp") }
    public var controllerConnected: Bool? { optionalBoolValue(values, "controllerConnected") }
    public var controllerFullyBooted: Bool? { optionalBoolValue(values, "controllerFullyBooted") }
    public var controllerMacAddress: String? { optionalStringValue(values, "controllerMacAddress") }
    public var controllerBatteryLevel: Int? { optionalIntValue(values, "controllerBatteryLevel") }
    public var controllerSignalStrength: Int? { optionalIntValue(values, "controllerSignalStrength") }
    public var ringSignalStrength: Int? { optionalIntValue(values, "ringSignalStrength") }

    public var description: String {
        values.description
    }
}

public struct BluetoothStatusUpdate: CustomStringConvertible {
    let values: [String: Any]

    init(values: [String: Any]) {
        var normalizedValues = values
        if let searchResults = values["searchResults"] as? [[String: Any]] {
            normalizedValues["searchResults"] = searchResults.compactMap { Device(values: $0)?.dictionary }
        }
        self.values = normalizedValues
    }

    public var searching: Bool? { optionalBoolValue(values, "searching") }
    public var searchingController: Bool? { optionalBoolValue(values, "searchingController") }
    public var systemMicUnavailable: Bool? { optionalBoolValue(values, "systemMicUnavailable") }
    public var micEnabled: Bool? { optionalBoolValue(values, "micEnabled") }
    public var currentMic: String? { optionalStringValue(values, "currentMic") }
    public var micRanking: [String]? { optionalStringListValue(values, "micRanking") }
    /// Nearby glasses in stable discovery order when included in an update. Existing entries keep their
    /// array position as details refresh; new glasses append at the end, and removals should not reorder
    /// remaining entries.
    public var searchResults: [Device]? {
        optionalDictionaryListValue(values, "searchResults")?.compactMap(Device.init(values:))
    }
    public var wifiScanResults: [WifiScanResult]? {
        optionalDictionaryListValue(values, "wifiScanResults")?.map(WifiScanResult.init(values:))
    }
    public var lastLog: [String]? { optionalStringListValue(values, "lastLog") }
    public var otherBtConnected: Bool? { optionalBoolValue(values, "otherBtConnected") }
    public var defaultWearable: String? { optionalStringValue(values, "default_wearable") }
    public var pendingWearable: String? { optionalStringValue(values, "pending_wearable") }
    public var deviceName: String? { optionalStringValue(values, "device_name") }
    public var deviceAddress: String? { optionalStringValue(values, "device_address") }
    public var defaultController: String? { optionalStringValue(values, "default_controller") }
    public var pendingController: String? { optionalStringValue(values, "pending_controller") }
    public var controllerDeviceName: String? { optionalStringValue(values, "controller_device_name") }
    public var screenDisabled: Bool? { optionalBoolValue(values, "screen_disabled") }
    public var preferredMic: String? { optionalStringValue(values, "preferred_mic") }
    public var sensingEnabled: Bool? { optionalBoolValue(values, "sensing_enabled") }
    public var powerSavingMode: Bool? { optionalBoolValue(values, "power_saving_mode") }
    public var brightness: Int? { optionalIntValue(values, "brightness") }
    public var autoBrightness: Bool? { optionalBoolValue(values, "auto_brightness") }
    public var dashboardHeight: Int? { optionalIntValue(values, "dashboard_height") }
    public var dashboardDepth: Int? { optionalIntValue(values, "dashboard_depth") }
    public var headUpAngle: Int? { optionalIntValue(values, "head_up_angle") }
    public var contextualDashboard: Bool? { optionalBoolValue(values, "contextual_dashboard") }
    public var galleryModeAuto: Bool? { optionalBoolValue(values, "galleryModeAuto") }
    public var buttonPhotoSize: ButtonPhotoSize? {
        optionalStringValue(values, "button_photo_size").flatMap(ButtonPhotoSize.init(rawValue:))
    }
    public var buttonCameraLed: Bool? { optionalBoolValue(values, "button_camera_led") }
    public var buttonMaxRecordingTime: Int? { optionalIntValue(values, "button_max_recording_time") }
    public var buttonVideoWidth: Int? { optionalIntValue(values, "button_video_width") }
    public var buttonVideoHeight: Int? { optionalIntValue(values, "button_video_height") }
    public var buttonVideoFrameRate: Int? { optionalIntValue(values, "button_video_fps") }
    public var shouldSendPcm: Bool? { optionalBoolValue(values, "should_send_pcm") }
    public var shouldSendLc3: Bool? { optionalBoolValue(values, "should_send_lc3") }
    public var shouldSendTranscript: Bool? { optionalBoolValue(values, "should_send_transcript") }
    public var bypassVad: Bool? { optionalBoolValue(values, "bypass_vad") }
    public var offlineCaptionsRunning: Bool? { optionalBoolValue(values, "offline_captions_running") }
    public var localSttFallbackActive: Bool? { optionalBoolValue(values, "local_stt_fallback_active") }
    public var shouldSendBootingMessage: Bool? { optionalBoolValue(values, "shouldSendBootingMessage") }

    public var description: String {
        values.description
    }
}
