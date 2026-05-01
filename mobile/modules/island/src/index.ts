// Services
export {default as webviewBridge} from "./services/WebviewBridge"
export {miniappRunningRegistry} from "./services/MiniappRunningRegistry"

// Utils
export {
  buildMiniappGlobalsScript,
  getCapsuleMenuRect,
  type BuildMiniappGlobalsOptions,
  type CapsuleMenuRect,
  type MiniappColorScheme,
  type MiniappSafeArea,
} from "./utils/miniappGlobals"
export {decideDevLaunchRoute, type DevLaunchResult, type DevManifest} from "./utils/devMiniappLaunch"
