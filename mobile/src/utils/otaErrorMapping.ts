export function getOtaErrorMessage(error?: string): string {
  switch (error) {
    case "no_internet":
      return "Glasses WiFi has no internet connection"
    case "ssl_error":
      return "Secure connection failed — try a different WiFi network"
    case "download_failed":
      return "Download failed — check glasses WiFi connection"
    default:
      return error || "Update failed"
  }
}
