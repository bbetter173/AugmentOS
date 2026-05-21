import * as RNFS from "@dr.pogodin/react-native-fs"

import {
  INVALID_DOWNLOADED_MEDIA,
  validateCaptureMetadataForDownload,
  validateDownloadedMediaFile,
} from "./galleryMediaValidation"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(),
  stat: jest.fn(),
  read: jest.fn(),
}))

describe("galleryMediaValidation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("validateCaptureMetadataForDownload", () => {
    it("rejects video captures with zero total_size", () => {
      expect(() =>
        validateCaptureMetadataForDownload({
          capture_id: "VID_test",
          type: "video",
          total_size: 0,
          files: [{name: "VID_test/base.mp4", size: 0, role: "primary"}],
        }),
      ).toThrow(INVALID_DOWNLOADED_MEDIA)
    })

    it("allows photo captures regardless of size rules", () => {
      expect(() =>
        validateCaptureMetadataForDownload({
          capture_id: "IMG_test",
          type: "photo",
          total_size: 0,
          files: [{name: "IMG_test/base.jpg", size: 0, role: "primary"}],
        }),
      ).not.toThrow()
    })
  })

  describe("validateDownloadedMediaFile", () => {
    it("rejects zero-byte files even when expected size is zero", async () => {
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 0})

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          expectedSize: 0,
          mediaKind: "video",
        }),
      ).rejects.toThrow(INVALID_DOWNLOADED_MEDIA)
    })

    it("rejects videos without ftyp signature", async () => {
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(Buffer.from("not-a-video-file").toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          mediaKind: "video",
        }),
      ).rejects.toThrow("invalid video container")
    })

    it("accepts valid mp4 header", async () => {
      const header = Buffer.alloc(12)
      header.writeUInt32BE(8, 0) // box size
      header.write("ftyp", 4, 4, "ascii")
      header.write("isom", 8, 4, "ascii")
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 1024})
      ;(RNFS.read as jest.Mock).mockResolvedValue(header.toString("base64"))

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/VID_test/base.mp4",
          name: "VID_test/base.mp4",
          expectedSize: 1024,
          mediaKind: "video",
        }),
      ).resolves.toBeUndefined()
    })

    it("accepts non-media sidecars when mediaKind is unknown", async () => {
      ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
      ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 128})

      await expect(
        validateDownloadedMediaFile({
          path: "/tmp/IMG_test/imu.json",
          name: "IMG_test/imu.json",
          expectedSize: 128,
          mediaKind: "unknown",
        }),
      ).resolves.toBeUndefined()

      expect(RNFS.read).not.toHaveBeenCalled()
    })
  })
})
