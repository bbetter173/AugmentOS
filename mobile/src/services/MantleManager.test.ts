import {waitFor} from "@testing-library/react-native"

jest.mock("core", () => {
  const {coreModuleMock} = require("../test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    loadUserSettings: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
      value: {
        contextual_dashboard: true,
        core_token: "server-token",
        auth_email: "from-server@example.com",
      },
    })),
    writeUserSettings: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    updateGlassesState: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendPhotoResponse: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendPhoneNotification: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendPhoneNotificationDismissed: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendCalendarData: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    sendLocationData: jest.fn(),
    goodbye: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
    getApplets: jest.fn(),
    configureAudioFormat: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
  },
}))

jest.mock("@/services/SocketComms", () => ({
  __esModule: true,
  default: {
    connectWebsocket: jest.fn(),
    cleanup: jest.fn(),
    sendTouchEvent: jest.fn(),
    sendButtonPress: jest.fn(),
    sendHeadPosition: jest.fn(),
    sendLocalTranscription: jest.fn(),
    sendSwipeVolumeStatus: jest.fn(),
    sendSwitchStatus: jest.fn(),
    sendRgbLedControlResponse: jest.fn(),
    sendText: jest.fn(),
    sendBinary: jest.fn(),
    sendStreamStatus: jest.fn(),
    sendKeepAliveAck: jest.fn(),
    handle_display_event: jest.fn(),
    sendLocationUpdate: jest.fn(),
  },
}))

jest.mock("@/services/asg/gallerySyncService", () => ({
  gallerySyncService: {
    initialize: jest.fn(),
  },
}))

jest.mock("@/services/UdpManager", () => ({
  __esModule: true,
  default: {
    enabledAndReady: jest.fn(() => false),
    sendAudio: jest.fn(),
    cleanup: jest.fn(),
  },
}))

jest.mock("@/services/Livekit", () => ({
  __esModule: true,
  default: {
    disconnect: jest.fn(),
  },
}))

jest.mock("@/services/Migrations", () => ({
  migrate: jest.fn(() => Promise.resolve()),
}))

jest.mock("@/services/bugReport/automaticBugReport", () => ({
  submitAutomaticBugIncident: jest.fn(),
}))

jest.mock("@/stores/applets", () => ({
  useAppletStatusStore: {
    getState: () => ({
      apps: [],
      refreshApplets: jest.fn(),
      startApplet: jest.fn(),
      stopApplet: jest.fn(),
    }),
    subscribe: jest.fn(() => ({
      remove: jest.fn(),
    })),
  },
}))

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {
    LOCATION: "location",
    MICROPHONE: "microphone",
  },
  checkFeaturePermissions: jest.fn(() => Promise.resolve(false)),
}))

jest.mock("@/utils/e2eMetrics", () => ({
  logE2EMetric: jest.fn(),
}))

jest.mock("@/utils/glassesMenu", () => ({
  syncDashboardMenu: jest.fn(() => Promise.resolve()),
}))

jest.mock("expo-calendar", () => ({
  getCalendarsAsync: jest.fn(() => Promise.resolve([])),
  getEventsAsync: jest.fn(() => Promise.resolve([])),
  EntityTypes: {EVENT: "event"},
}))

jest.mock("expo-location", () => ({
  LocationAccuracy: {
    BestForNavigation: 1,
    High: 2,
    Balanced: 3,
    Low: 4,
    Lowest: 5,
  },
  stopLocationUpdatesAsync: jest.fn(() => Promise.resolve()),
  startLocationUpdatesAsync: jest.fn(() => Promise.resolve()),
  getCurrentPositionAsync: jest.fn(() =>
    Promise.resolve({
      coords: {latitude: 1, longitude: 2, accuracy: 3},
    }),
  ),
}))

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
}))

import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import mantle from "./MantleManager"
import {useCoreStore} from "@/stores/core"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {coreModuleMock, emitCoreEvent, resetCoreModuleMock} from "@/test-utils/mockCoreModule"

describe("MantleManager", () => {
  beforeAll(async () => {
    jest.useFakeTimers()
    resetCoreModuleMock()
    useCoreStore.getState().reset()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    useDisplayStore.setState({view: "main"})
    await mantle.init()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("syncs native status, routes events, and forwards core setting changes", async () => {
    expect(coreModuleMock.updateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        contextual_dashboard: true,
        core_token: "server-token",
        auth_email: "from-server@example.com",
      }),
    )

    emitCoreEvent("core_status", {searching: true, otherBtConnected: true})
    emitCoreEvent("glasses_status", {connected: true, deviceModel: "Mentra Live", batteryLevel: 77})

    expect(useCoreStore.getState().searching).toBe(true)
    expect(useCoreStore.getState().otherBtConnected).toBe(true)
    expect(useGlassesStore.getState().connected).toBe(true)
    expect(useGlassesStore.getState().deviceModel).toBe("Mentra Live")
    expect(useGlassesStore.getState().batteryLevel).toBe(77)

    emitCoreEvent("photo_response", {
      type: "photo_response",
      requestId: "req-1",
      photoUrl: "https://example.com/photo.jpg",
      timestamp: 123,
      success: true,
    })
    expect(restComms.sendPhotoResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        photoUrl: "https://example.com/photo.jpg",
      }),
    )

    emitCoreEvent("touch_event", {
      gesture_name: "tap",
      timestamp: 999,
    })
    expect(socketComms.sendTouchEvent).toHaveBeenCalledWith({
      device_model: "Mentra Live",
      gesture_name: "tap",
      timestamp: 999,
    })

    emitCoreEvent("local_transcription", {
      text: "hello world",
      isFinal: true,
      transcribeLanguage: "en-US",
    })
    await waitFor(() => {
      expect(socketComms.sendLocalTranscription).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello world",
          isFinal: true,
        }),
      )
    })

    emitCoreEvent("head_up", {up: true})
    expect(socketComms.sendHeadPosition).toHaveBeenCalledWith(true)
    await waitFor(() => {
      expect(useDisplayStore.getState().view).toBe("dashboard")
    })
    ;(coreModuleMock.updateCore as jest.Mock).mockClear()
    await useSettingsStore.getState().setSetting(SETTINGS.core_token.key, "new-token", false)
    expect(coreModuleMock.updateCore).toHaveBeenCalledWith(
      expect.objectContaining({
        core_token: "new-token",
      }),
    )
  })
})
