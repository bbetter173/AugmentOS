import CoreModule from "@mentra/bluetooth-sdk"

import {asgCameraApi} from "@/services/asg/asgCameraApi"
import {gallerySyncNotifications} from "@/services/asg/gallerySyncNotifications"
import {localStorageService} from "@/services/asg/localStorageService"
import {mediaProcessingQueue} from "@/services/asg/mediaProcessingQueue"
import {gallerySyncService} from "./gallerySyncService"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {useGlassesStore} from "@/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("@dr.pogodin/react-native-fs", () => ({
  getFSInfo: jest.fn(() => Promise.resolve({freeSpace: 1024 * 1024 * 1024})),
}))

jest.mock("@react-native-community/netinfo", () => ({
  fetch: jest.fn(() => Promise.resolve({isWifiEnabled: true, isConnected: true, isInternetReachable: true})),
}))

jest.mock("react-native-wifi-reborn", () => ({
  isEnabled: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {LOCATION: "location"},
  checkConnectivityRequirementsUI: jest.fn(() => Promise.resolve(true)),
  checkFeaturePermissions: jest.fn(() => Promise.resolve(true)),
  requestFeaturePermissions: jest.fn(() => Promise.resolve(true)),
  isLocationServicesEnabled: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("@/utils/AlertUtils", () => ({
  showAlert: jest.fn(),
  __esModule: true,
  default: jest.fn(),
}))

jest.mock("@/utils/SettingsNavigationUtils", () => ({
  SettingsNavigationUtils: {
    openWifiSettings: jest.fn(),
  },
}))

jest.mock("@/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    checkPermission: jest.fn(() => Promise.resolve(true)),
    requestPermission: jest.fn(() => Promise.resolve(true)),
  },
}))

jest.mock("@/services/asg/gallerySettingsService", () => ({
  gallerySettingsService: {
    getAutoSaveToCameraRoll: jest.fn(() => Promise.resolve(false)),
  },
}))

jest.mock("@/services/asg/gallerySyncNotifications", () => ({
  gallerySyncNotifications: {
    requestPermissions: jest.fn(() => Promise.resolve()),
    showSyncError: jest.fn(),
  },
}))

jest.mock("@/services/asg/localStorageService", () => ({
  localStorageService: {
    getSyncQueue: jest.fn(() => Promise.resolve(null)),
    hasResumableSyncQueue: jest.fn(() => Promise.resolve(false)),
    updateSyncQueueIndex: jest.fn(() => Promise.resolve()),
    getSyncState: jest.fn(() => Promise.resolve({total_downloaded: 0, total_size: 0})),
    updateSyncState: jest.fn(() => Promise.resolve()),
    clearSyncQueue: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("@/services/asg/mediaProcessingQueue", () => ({
  mediaProcessingQueue: {
    reset: jest.fn(),
    enqueue: jest.fn(),
    waitUntilDrained: jest.fn(() => Promise.resolve()),
    abort: jest.fn(),
  },
}))

jest.mock("@/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    setServer: jest.fn(),
    syncWithServer: jest.fn(),
    downloadCapture: jest.fn(),
  },
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => key),
}))

describe("GallerySyncService", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    useGallerySyncStore.getState().reset()
    useGlassesStore.getState().reset()
    gallerySyncService.cleanup()
  })

  afterEach(() => {
    gallerySyncService.cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("updates gallery status from glasses events", () => {
    gallerySyncService.initialize()

    GlobalEventEmitter.emit("gallery_status", {
      photos: 2,
      videos: 1,
      total: 3,
      has_content: true,
      camera_busy: false,
    })

    expect(useGallerySyncStore.getState()).toEqual(
      expect.objectContaining({
        glassesPhotoCount: 2,
        glassesVideoCount: 1,
        glassesTotalCount: 3,
        glassesHasContent: true,
      }),
    )
  })

  it("cancels an active sync if glasses disconnect", () => {
    gallerySyncService.initialize()
    useGlassesStore.getState().setGlassesInfo({connected: true})
    useGallerySyncStore.getState().setRequestingHotspot()

    useGlassesStore.getState().setGlassesInfo({connected: false})

    expect(useGallerySyncStore.getState().syncState).toBe("error")
    expect(useGallerySyncStore.getState().lastError).toBe("Glasses disconnected")
    expect(gallerySyncNotifications.showSyncError).toHaveBeenCalledWith("Glasses disconnected")
  })

  it("requests hotspot and records ownership when starting sync", async () => {
    useGlassesStore.getState().setGlassesInfo({connected: true})

    await gallerySyncService.startSync()

    expect(useGallerySyncStore.getState().syncState).toBe("requesting_hotspot")
    expect(useGallerySyncStore.getState().syncServiceOpenedHotspot).toBe(true)
    expect(CoreModule.setHotspotState).toHaveBeenCalledWith(true)
  })

  it("keeps sync watermark before zero-byte video captures", async () => {
    const serverTime = 1_700_000_000_000
    const failedTimestamp = serverTime - 5_000
    const zeroByteCapture = {
      capture_id: "VID_zero",
      type: "video" as const,
      timestamp: failedTimestamp,
      total_size: 0,
      files: [{name: "VID_zero/base.mp4", size: 0, role: "primary" as const}],
    }

    await (gallerySyncService as any).executeCaptureDownload([zeroByteCapture], serverTime)

    expect(asgCameraApi.downloadCapture).not.toHaveBeenCalled()
    expect(mediaProcessingQueue.enqueue).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState().failedFiles).toContain("VID_zero")
    expect(localStorageService.updateSyncState).toHaveBeenCalledWith({
      last_sync_time: failedTimestamp - 1,
      total_downloaded: 0,
      total_size: 0,
    })
  })
})
