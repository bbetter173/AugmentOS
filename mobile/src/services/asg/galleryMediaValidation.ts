/**
 * Post-download validation for gallery media synced from glasses.
 */

import * as RNFS from "@dr.pogodin/react-native-fs"

export const INVALID_DOWNLOADED_MEDIA = "Invalid downloaded media"

export type MediaKind = "photo" | "video" | "unknown"

export interface ValidateDownloadedMediaOptions {
  path: string
  name: string
  expectedSize?: number
  mediaKind?: MediaKind
}

function isVideoFileName(name: string): boolean {
  return /\.(mp4|mov|avi|webm|mkv|3gp)$/i.test(name)
}

function isPhotoFileName(name: string): boolean {
  return /\.(jpg|jpeg|png|avif)$/i.test(name) || !name.includes(".")
}

function detectMediaKind(name: string, override?: MediaKind): MediaKind {
  if (override && override !== "unknown") {
    return override
  }
  if (isVideoFileName(name)) {
    return "video"
  }
  if (isPhotoFileName(name)) {
    return "photo"
  }
  return "unknown"
}

function validatePhotoSignature(base64Header: string): boolean {
  try {
    const decodedBytes = atob(base64Header)
    if (decodedBytes.length > 11) {
      const ftypSignature = decodedBytes.substring(4, 12)
      if (ftypSignature === "ftypavif") {
        return true
      }
    }
    if (decodedBytes.substring(0, 2) === "\xFF\xD8") {
      return true
    }
    if (decodedBytes.substring(0, 8) === "\x89PNG\r\n\x1a\n") {
      return true
    }
  } catch {
    return false
  }
  return false
}

function validateVideoSignature(base64Header: string): boolean {
  try {
    const decodedBytes = atob(base64Header)
    if (decodedBytes.length < 8) {
      return false
    }
    // ISO BMFF (mp4, mov, 3gp): bytes 4-7 should be "ftyp"
    if (decodedBytes.substring(4, 8) === "ftyp") {
      return true
    }
    // RIFF/AVI: bytes 0-3 "RIFF", bytes 8-11 "AVI "
    if (decodedBytes.length >= 12 && decodedBytes.substring(0, 4) === "RIFF" && decodedBytes.substring(8, 12) === "AVI ") {
      return true
    }
    // EBML (WebM, MKV): bytes 0-3 are 0x1A 0x45 0xDF 0xA3
    if (
      decodedBytes.charCodeAt(0) === 0x1a &&
      decodedBytes.charCodeAt(1) === 0x45 &&
      decodedBytes.charCodeAt(2) === 0xdf &&
      decodedBytes.charCodeAt(3) === 0xa3
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Validate a downloaded file on disk. Throws with INVALID_DOWNLOADED_MEDIA on failure.
 */
export async function validateDownloadedMediaFile(options: ValidateDownloadedMediaOptions): Promise<void> {
  const {path, name, expectedSize = 0, mediaKind} = options

  const exists = await RNFS.exists(path)
  if (!exists) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: missing file ${name}`)
  }

  const stat = await RNFS.stat(path)
  if (stat.size === 0) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: zero-byte file ${name}`)
  }

  if (expectedSize > 0 && stat.size !== expectedSize) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: size mismatch for ${name}: expected ${expectedSize}, got ${stat.size}`)
  }

  const kind = detectMediaKind(name, mediaKind)
  if (kind === "unknown") {
    return
  }

  const headerBase64 = await RNFS.read(path, 12, 0, "base64")
  if (kind === "video") {
    if (!validateVideoSignature(headerBase64)) {
      throw new Error(`${INVALID_DOWNLOADED_MEDIA}: invalid video container for ${name}`)
    }
    return
  }

  if (!validatePhotoSignature(headerBase64)) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: invalid photo signature for ${name}`)
  }
}

/**
 * Pre-download check using sync metadata before hitting the network.
 */
export function validateCaptureMetadataForDownload(capture: {
  capture_id: string
  type: "photo" | "video"
  total_size: number
  files: Array<{name: string; size: number; role: string}>
}): void {
  if (capture.type !== "video") {
    return
  }

  if (capture.total_size <= 0) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: video capture ${capture.capture_id} has zero total_size`)
  }

  const primaryFile = capture.files.find((f) => f.role === "primary") ?? capture.files[0]
  if (!primaryFile) {
    throw new Error(`${INVALID_DOWNLOADED_MEDIA}: video capture ${capture.capture_id} has no files`)
  }
  if (primaryFile.size <= 0) {
    throw new Error(
      `${INVALID_DOWNLOADED_MEDIA}: video capture ${capture.capture_id} primary file ${primaryFile.name} has zero size`,
    )
  }
}
