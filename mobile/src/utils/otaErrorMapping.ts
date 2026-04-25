export function getOtaErrorMessage(error?: string): string {
  switch (error) {
    case "no_internet":
      return "Glasses WiFi has no internet connection"
    case "ssl_error":
      return "Secure connection failed — try a different WiFi network"
    case "download_failed":
      return "Download failed — check glasses WiFi connection"
    case "firmware_too_large":
      return "Firmware file is unexpectedly large — please contact support"
    case "firmware_verify_failed":
      return "Firmware verification failed — please try again or contact support"
    case "install_failed":
      return "Install failed — please try again"
    default:
      return error || "Update failed"
  }
}
