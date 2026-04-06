#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

async function ensureFullXcodeSelected() {
  const selectedDeveloperDir = (await $`xcode-select -p`.text()).trim()
  const usingCommandLineTools = selectedDeveloperDir === "/Library/Developer/CommandLineTools"

  if (usingCommandLineTools) {
    console.error("Full Xcode is required to run on a physical iPhone.")
    console.error(`Current developer directory: ${selectedDeveloperDir}`)
    console.error("")
    console.error("`xcode-select --install` is not enough here; it only installs Command Line Tools.")
    console.error("")
    console.error("Install full Xcode from:")
    console.error("  https://apps.apple.com/us/app/xcode/id497799835")
    console.error("")
    console.error("After installing Xcode, switch to it with:")
    console.error("  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer")
    console.error("  sudo xcodebuild -license accept")
    console.error("")
    console.error("Then open Xcode once and finish any first-launch setup if prompted.")
    console.error("")
    console.error("Verify the setup with:")
    console.error("  xcodebuild -version")
    console.error("  xcrun --find devicectl")
    process.exit(1)
  }

  try {
    await $`xcrun --find devicectl`
  } catch {
    console.error("Xcode is selected, but `devicectl` is still unavailable.")
    console.error("Make sure you have a recent full Xcode installed and have opened it at least once.")
    process.exit(1)
  }
}

await ensureFullXcodeSelected()

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Get connected iOS devices via devicectl
const tmpFile = `/tmp/devicectl-${Date.now()}.json`
await $`xcrun devicectl list devices --json-output ${tmpFile} --timeout 5`
const json = JSON.parse(await fs.readFile(tmpFile, "utf-8"))
await fs.remove(tmpFile)

const device =
  json.result?.devices?.find(
    (d) => d.capabilities?.some((c) => c.name === "iPhone") || d.deviceProperties?.marketingName?.includes("iPhone"),
  ) &&
  json.result.devices.find(
    (d) =>
      (d.capabilities?.some((c) => c.name === "iPhone") || d.deviceProperties?.marketingName?.includes("iPhone")) &&
      d.connectionProperties?.tunnelState === "connected",
  )

if (!device) {
  // Fallback: find any available paired iPhone
  const available = json.result?.devices?.find(
    (d) =>
      d.hardwareProperties?.deviceType === "iPhone" &&
      d.connectionProperties?.pairingState === "paired" &&
      d.connectionProperties?.tunnelState !== "unavailable",
  )
  if (!available) {
    console.error("No physical iPhone found")
    process.exit(1)
  }
  var deviceName = available.deviceProperties.name
} else {
  var deviceName = device.deviceProperties.name
}

console.log(`Using device: ${deviceName}`)
await $({stdio: "inherit"})`bun expo run:ios --device ${deviceName}`
