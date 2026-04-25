import {getOtaErrorMessage} from "../otaErrorMapping"

describe("getOtaErrorMessage", () => {
  it("maps no_internet to WiFi message", () => {
    expect(getOtaErrorMessage("no_internet")).toBe("Glasses WiFi has no internet connection")
  })

  it("maps ssl_error to connection message", () => {
    expect(getOtaErrorMessage("ssl_error")).toBe("Secure connection failed — try a different WiFi network")
  })

  it("maps download_failed to download message", () => {
    expect(getOtaErrorMessage("download_failed")).toBe("Download failed — check glasses WiFi connection")
  })

  it("maps firmware_too_large to size message", () => {
    expect(getOtaErrorMessage("firmware_too_large")).toBe(
      "Firmware file is unexpectedly large — please contact support",
    )
  })

  it("maps firmware_verify_failed to verify message", () => {
    expect(getOtaErrorMessage("firmware_verify_failed")).toBe(
      "Firmware verification failed — please try again or contact support",
    )
  })

  it("maps install_failed to install message", () => {
    expect(getOtaErrorMessage("install_failed")).toBe("Install failed — please try again")
  })

  it("returns generic message for undefined error", () => {
    expect(getOtaErrorMessage(undefined)).toBe("Update failed")
  })

  it("passes through arbitrary error strings", () => {
    expect(getOtaErrorMessage("some_custom_error")).toBe("some_custom_error")
  })

  it("returns generic message for empty string", () => {
    expect(getOtaErrorMessage("")).toBe("Update failed")
  })
})
