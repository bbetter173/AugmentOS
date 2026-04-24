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
