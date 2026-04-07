/* eslint-disable import/first */

const mockGlasses = {connected: true}

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
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
      bluetoothName: "mentra_1",
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
    }),
  },
}))

jest.mock("@/utils/dev/logging", () => ({
  logBuffer: {
    getRecentLogs: jest.fn(() => [{timestamp: 1, level: "info", message: "test log line"}]),
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
import {logBuffer} from "@/utils/dev/logging"
import {submitBugIncident} from "./bugReportIncident"

const okAsync = <T>(value: T) => ({
  is_error: () => false as const,
  value,
})

const errAsync = (error: Error) => ({
  is_error: () => true as const,
  error,
})

describe("submitBugIncident (integration-style)", () => {
  const feedbackData = {type: "bug", expectedBehavior: "e", actualBehavior: "a", severityRating: 5}

  beforeEach(() => {
    jest.clearAllMocks()
    mockGlasses.connected = true
    ;(logBuffer.getRecentLogs as jest.Mock).mockReturnValue([{timestamp: 1, level: "info", message: "test log line"}])
    ;(restComms.createIncident as jest.Mock).mockResolvedValue(okAsync({success: true, incidentId: "incident-e2e-1"}))
    ;(restComms.uploadIncidentLogs as jest.Mock).mockResolvedValue(okAsync(undefined))
    ;(restComms.uploadIncidentAttachments as jest.Mock).mockResolvedValue(okAsync({uploaded: 1, errors: 0}))
  })

  it("calls createIncident with feedback and phoneState, uploads logs, sendIncidentId when glasses connected", async () => {
    const result = await submitBugIncident(feedbackData)

    expect(result).toEqual({ok: true, incidentId: "incident-e2e-1"})
    expect(restComms.createIncident).toHaveBeenCalledTimes(1)
    const [fd, phoneState] = (restComms.createIncident as jest.Mock).mock.calls[0]
    expect(fd).toEqual(feedbackData)
    expect(phoneState).toMatchObject({
      installedApplets: ["com.example.applet"],
      settings: {public_setting: "x"},
    })
    expect(phoneState.glasses).toMatchObject({connected: true, deviceModel: "G1"})

    expect(restComms.uploadIncidentLogs).toHaveBeenCalledWith("incident-e2e-1", [
      {timestamp: 1, level: "info", message: "test log line"},
    ])
    expect(CoreModule.sendIncidentId).toHaveBeenCalledWith("incident-e2e-1")
    expect(restComms.uploadIncidentAttachments).not.toHaveBeenCalled()
  })

  it("does not upload logs or call sendIncidentId when createIncident fails", async () => {
    ;(restComms.createIncident as jest.Mock).mockResolvedValue(errAsync(new Error("network")))

    const result = await submitBugIncident(feedbackData)

    expect(result).toEqual({ok: false, error: expect.any(Error)})
    expect(restComms.uploadIncidentLogs).not.toHaveBeenCalled()
    expect(CoreModule.sendIncidentId).not.toHaveBeenCalled()
  })

  it("skips uploadIncidentLogs when ring buffer is empty", async () => {
    ;(logBuffer.getRecentLogs as jest.Mock).mockReturnValue([])

    await submitBugIncident(feedbackData)

    expect(restComms.uploadIncidentLogs).not.toHaveBeenCalled()
    expect(CoreModule.sendIncidentId).toHaveBeenCalledWith("incident-e2e-1")
  })

  it("does not call sendIncidentId when glasses disconnected", async () => {
    mockGlasses.connected = false

    await submitBugIncident(feedbackData)

    expect(CoreModule.sendIncidentId).not.toHaveBeenCalled()
  })

  it("uploads screenshots when provided", async () => {
    const screenshots = [{uri: "file:///tmp/a.jpg", fileName: "a.jpg", mimeType: "image/jpeg"}]

    await submitBugIncident(feedbackData, {screenshots})

    expect(restComms.uploadIncidentAttachments).toHaveBeenCalledWith("incident-e2e-1", screenshots)
  })
})
