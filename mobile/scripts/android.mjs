#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

async function ensureAndroidSdkConfigured() {
  const sdkPathCandidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    `${process.env.HOME}/Library/Android/sdk`,
    `${process.env.HOME}/Android/Sdk`,
    "/opt/android-sdk",
  ].filter(Boolean)

  const sdkPath = sdkPathCandidates.find((candidate) => fs.existsSync(candidate))

  if (!sdkPath) {
    console.error("Android SDK not found.")
    console.error("Set ANDROID_HOME or ANDROID_SDK_ROOT, or install the SDK in one of these locations:")
    sdkPathCandidates.forEach((candidate) => console.error(`  ${candidate}`))
    process.exit(1)
  }

  const localPropertiesPath = "./android/local.properties"
  const escapedSdkPath = sdkPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:")
  await fs.writeFile(localPropertiesPath, `sdk.dir=${escapedSdkPath}\n`)
  console.log(`Configured Android SDK: ${sdkPath}`)
}

// prebuild android:
await $({stdio: "inherit"})`bun expo prebuild --platform android`

await ensureAndroidSdkConfigured()

// Get connected devices with details
const adbOutput = await $`adb devices -l`
const lines = adbOutput.stdout.trim().split('\n').slice(1)

// Filter to physical devices that don't contain "live"
const validDevices = lines.filter(line => 
  line.trim() && 
  !line.includes('emulator') && 
  !line.toLowerCase().includes('live') &&
  !line.startsWith('emulator')
)

if (validDevices.length === 0) {
  console.error('No suitable physical device found')
  process.exit(1)
}

// build only for real devices new arch:
process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a'

if (validDevices.length > 1) {
  console.log('Multiple devices found, launching interactive picker')
  await $({stdio: "inherit"})`bun expo run:android --device`
} else {
  const modelMatch = validDevices[0].match(/model:(\S+)/)
  const deviceName = modelMatch ? modelMatch[1] : validDevices[0].split(/\s+/)[0]
  console.log(`Using device: ${deviceName}`)
  await $({stdio: "inherit"})`bun expo run:android --device ${deviceName}`
}
