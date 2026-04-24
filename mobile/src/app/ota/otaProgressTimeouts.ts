/** Shared OTA progress watchdog timings (see progress-legacy.tsx / progress.tsx). */

export const MAX_RETRIES = 3
export const RETRY_INTERVAL_MS = 5000
/** APK/BES and general install when progress events are expected */
export const PROGRESS_TIMEOUT_MS = 120_000
/** Fail if still at 0% in starting/downloading */
export const DOWNLOAD_STUCK_TIMEOUT_MS = 70_000
/** MTK system install often goes quiet for long periods */
export const MTK_INSTALL_TIMEOUT_MS = 300_000
/** Whole multi-step session cap */
export const GLOBAL_OTA_TIMEOUT_MS = 20 * 60 * 1000
/** After APK reboot, ASG OTA service needs time before next ota_start */
export const POST_APK_OTA_START_DELAY_MS = 6000
/** BLE keepalive during OTA */
export const PING_INTERVAL_MS = 10_000

export const OtaProgressMessages = {
  noAckResponse: "Unable to start update. Glasses did not respond.",
  stalledOrStuck: "Update may have failed. Ensure glasses have internet access and try again.",
  globalTimeout: "Update took too long. Please try again.",
  sendOtaStartFailed: "Failed to communicate with glasses.",
} as const
