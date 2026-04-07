/* eslint-disable import/first */

/**
 * Full simulation: same path as AwesomeGalleryViewer Video onError ->
 * submitGalleryVideoPlaybackBugReport -> buildBugReportFeedbackDataForBug -> submitBugIncident.
 */

const mockGlasses = {connected: true}

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(() =>
      Promise.resolve({
        type: "wifi",
        isConnected: true,
        isInternetReachable: true,
      }),
    ),
  },
}))

jest.mock("expo-location", () => ({
  getForegroundPermissionsAsync: jest.fn(() => Promise.resolve({status: "denied"})),
}))

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    deviceName: "JestPhone",
  },
}))

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    getCoreToken: jest.fn(() => "simulated-core-token"),
    createIncident: jest.fn(),
    uploadIncidentLogs: jest.fn(),
    uploadIncidentAttachments: jest.fn(),
  },
}))

jest.mock("@/stores/glasses", () => ({
  useGlassesStore: {
    getState: () => ({
      connected: mockGlasses.connected,
      deviceModel: "G1",
      bluetoothName: "mentra_sim",
      buildNumber: "b",
      fwVersion: "f",
      appVersion: "a",
      serialNumber: "sn",
      androidVersion: "14",
      wifiConnected: false,
      wifiSsid: "",
      batteryLevel: -1,
    }),
  },
}))

jest.mock("@/stores/applets", () => ({
  useAppletStatusStore: {
    getState: () => ({
      apps: [{packageName: "com.example.applet", running: true}],
    }),
  },
}))

jest.mock("@/stores/settings", () => ({
  SETTINGS: {
    offline_mode: {key: "offline_mode"},
    default_wearable: {key: "default_wearable"},
    contact_email: {key: "contact_email"},
  },
  useSettingsStore: {
    getState: () => ({
      settings: {public_setting: "x"},
      getSetting: jest.fn((key: string) => {
        if (key === "offline_mode") {
          return Promise.resolve(false)
        }
        if (key === "default_wearable") {
          return Promise.resolve("MentraLive")
        }
        return Promise.resolve(undefined)
      }),
    }),
  },
}))

jest.mock("@/utils/dev/logging", () => ({
  logBuffer: {
    getRecentLogs: jest.fn(() => [{timestamp: 99, level: "info", message: "simulated ring buffer"}]),
  },
}))

jest.mock("core", () => ({
  __esModule: true,
  default: {
    sendIncidentId: jest.fn(),
    getBluetoothStatus: jest.fn(),
    requestBluetoothPermissions: jest.fn(),
  },
}))

import CoreModule from "core"

import restComms from "@/services/RestComms"
import type {PhotoInfo} from "@/types/asg"
import {
  resetGalleryVideoReportDedupeRegistryForTests,
  submitGalleryVideoPlaybackBugReport,
} from "./galleryVideoPlaybackBugReport"

const okAsync = <T>(value: T) => ({
  is_error: () => false as const,
  value,
})

/** Same shape react-native-video passes to onError on iOS for corrupt media. */
const simulatedVideoOnErrorPayload = {
  error: {
    domain: "AVFoundationErrorDomain",
    code: -11829,
    localizedDescription: "Cannot Open",
    errorString: "Cannot Open",
  },
}

const simulatedPhoto: PhotoInfo = {
  name: "IMG_SIM_ONERROR/corrupt.mp4",
  url: "file:///data/user/0/com.mentra.mentra/cache/fake_corrupt.mp4",
  download: "file:///data/user/0/com.mentra.mentra/cache/fake_corrupt.mp4",
  size: 2048,
  modified: 1_700_000_000_000,
  is_video: true,
  mime_type: "video/mp4",
}

describe("gallery video onError simulation (full pipeline)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(restComms.getCoreToken as jest.Mock).mockReturnValue("simulated-core-token")
    resetGalleryVideoReportDedupeRegistryForTests()
    mockGlasses.connected = true
    ;(restComms.createIncident as jest.Mock).mockResolvedValue(
      okAsync({success: true, incidentId: "sim-incident-full-pipeline"}),
    )
    ;(restComms.uploadIncidentLogs as jest.Mock).mockResolvedValue(okAsync(undefined))
  })

  it("runs buildBugReportFeedbackDataForBug + submitBugIncident after simulated onError", async () => {
    await submitGalleryVideoPlaybackBugReport(simulatedPhoto, simulatedVideoOnErrorPayload, true)

    expect(restComms.getCoreToken).toHaveBeenCalled()
    expect(restComms.createIncident).toHaveBeenCalledTimes(1)
    const [feedback, phoneState] = (restComms.createIncident as jest.Mock).mock.calls[0]

    expect(feedback).toMatchObject({
      type: "bug",
      severityRating: 5,
      automatic: true,
      source: "gallery_video_onError",
      expectedBehavior: "Video should play in the glasses gallery.",
    })

    const actualBehavior = JSON.parse(feedback.actualBehavior as string)
    expect(actualBehavior.photoName).toBe("IMG_SIM_ONERROR/corrupt.mp4")
    expect(actualBehavior.isActive).toBe(true)
    expect(actualBehavior.uriScheme).toBe("file")
    expect(actualBehavior.playerError.domain).toBe("AVFoundationErrorDomain")
    expect(actualBehavior.playerError.code).toBe(-11829)

    expect((feedback.systemInfo as {glassesConnected?: boolean}).glassesConnected).toBe(true)
    expect(feedback.glassesInfo).toBeDefined()

    expect(phoneState).toMatchObject({
      installedApplets: ["com.example.applet"],
      settings: {public_setting: "x"},
    })

    expect(restComms.uploadIncidentLogs).toHaveBeenCalledWith("sim-incident-full-pipeline", [
      {timestamp: 99, level: "info", message: "simulated ring buffer"},
    ])
    expect(CoreModule.sendIncidentId).toHaveBeenCalledWith("sim-incident-full-pipeline")
  })

  it("skips pipeline when no core token (same as logged-out user)", async () => {
    ;(restComms.getCoreToken as jest.Mock).mockReturnValue(null)

    await submitGalleryVideoPlaybackBugReport(simulatedPhoto, simulatedVideoOnErrorPayload, false)

    expect(restComms.createIncident).not.toHaveBeenCalled()
  })

  it("second identical onError within dedupe window does not file again", async () => {
    await submitGalleryVideoPlaybackBugReport(simulatedPhoto, simulatedVideoOnErrorPayload, true)
    await submitGalleryVideoPlaybackBugReport(simulatedPhoto, simulatedVideoOnErrorPayload, true)

    expect(restComms.createIncident).toHaveBeenCalledTimes(1)
  })
})
