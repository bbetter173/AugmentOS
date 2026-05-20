import * as RNFS from "@dr.pogodin/react-native-fs"

import {localStorageService} from "@/services/asg/localStorageService"
import {useGallerySyncStore} from "@/stores/gallerySync"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(),
  stat: jest.fn(),
  read: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(() => Promise.resolve()),
}))

jest.mock("crust", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("@/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    deleteFilesFromServer: jest.fn(),
  },
}))

jest.mock("@/services/asg/localStorageService", () => ({
  localStorageService: {
    convertToDownloadedFile: jest.fn((info: any) => info),
    saveDownloadedFile: jest.fn(),
  },
}))

jest.mock("@/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    saveToLibrary: jest.fn(),
  },
}))

import {mediaProcessingQueue} from "./mediaProcessingQueue"

describe("mediaProcessingQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useGallerySyncStore.getState().reset()
  })

  it("does not save metadata when local file is zero bytes", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 0})

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "VID_zero",
      type: "video",
      primaryPath: "/tmp/VID_zero/base.mp4",
      totalSize: 0,
      shouldProcess: false,
      shouldAutoSave: false,
      deleteFromGlasses: ["VID_zero"],
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(localStorageService.saveDownloadedFile).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState().failedFiles).toContain("VID_zero")
  })
})
