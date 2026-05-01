import {appRegistry, HardwareRequirementLevel, HardwareType, type ClientApp} from "island"

import {translate} from "@/i18n"

import {
  cameraPackageName,
  captionsPackageName,
  feedbackPackageName,
  lmaInstallerPackageName,
  mirrorPackageName,
  notifyPackageName,
  settingsPackageName,
  storePackageName,
} from "@/constants/miniapps"
import {SETTINGS, useSettingsStore} from "@/stores/settings"

/**
 * MiniappCatalog
 *
 * Owns the set of "offline" applets — local React-Native miniapps that route
 * to in-app screens instead of running in a webview. Registers them with the
 * island's AppRegistry at boot via `appRegistry.installOfflineApp(app)`.
 *
 * Custom start/stop side effects (Camera setting flip, Captions STT model
 * gate, etc.) intentionally do NOT live on the app objects — `installOfflineApp`
 * replaces the provided `onStart`/`onStop` with default running-state writers.
 * Those side effects belong in the host's `beforeStart`/`beforeStop` hooks
 * (wired separately).
 */
class MiniappCatalog {
  private static _instance: MiniappCatalog | null = null
  private initialized = false

  static getInstance(): MiniappCatalog {
    if (!MiniappCatalog._instance) {
      MiniappCatalog._instance = new MiniappCatalog()
    }
    return MiniappCatalog._instance
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    for (const app of this.buildOfflineApps()) {
      appRegistry.installOfflineApp(app)
    }
  }

  private buildOfflineApps(): ClientApp[] {
    const apps: ClientApp[] = [
      {
        packageName: cameraPackageName,
        name: translate("miniApps:camera"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/camera.png"),
        webviewUrl: "",
        permissions: [],
        offlineRoute: "/asg/gallery",
        local: false,
        running: false,
        loading: false,
        healthy: true,
        hidden: false,
        hardwareRequirements: [
          {type: HardwareType.CAMERA, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      },
      {
        packageName: captionsPackageName,
        name: translate("miniApps:offlineCaptions"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/captions.png"),
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "",
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      },
      {
        packageName: notifyPackageName,
        name: translate("miniApps:notify"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/notification.png"),
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "",
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      },
      {
        packageName: settingsPackageName,
        name: translate("miniApps:settings"),
        type: "background",
        offline: true,
        logoUrl: require("@assets/applet-icons/settings.png"),
        local: false,
        running: false,
        loading: false,
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "/miniapps/settings/main",
        webviewUrl: "",
        hardwareRequirements: [],
      },
      {
        packageName: storePackageName,
        name: translate("miniApps:store"),
        offlineRoute: "/miniapps/store/store",
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offline: true,
        running: false,
        loading: false,
        hardwareRequirements: [],
        type: "background",
        logoUrl: require("@assets/applet-icons/store.png"),
        local: false,
      },
      {
        packageName: mirrorPackageName,
        name: translate("miniApps:mirror"),
        offlineRoute: "/miniapps/mirror/mirror",
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offline: true,
        running: false,
        loading: false,
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
        type: "background",
        logoUrl: require("@assets/applet-icons/mirror.png"),
        local: false,
      },
      {
        packageName: feedbackPackageName,
        name: translate("miniApps:feedback"),
        type: "background",
        offline: true,
        logoUrl: require("@assets/applet-icons/feedback.png"),
        offlineRoute: "/miniapps/settings/feedback",
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [],
      },
    ]

    if (useSettingsStore.getState().getSetting(SETTINGS.super_mode.key)) {
      apps.push({
        packageName: lmaInstallerPackageName,
        name: translate("miniApps:lmaInstaller"),
        type: "standard",
        offline: true,
        offlineRoute: "/miniapps/miniappdev/main",
        local: false,
        webviewUrl: "",
        permissions: [],
        running: false,
        loading: false,
        healthy: true,
        hidden: false,
        hardwareRequirements: [],
        logoUrl: require("@assets/applet-icons/store.png"),
      })
    }

    return apps
  }
}

const miniappCatalog = MiniappCatalog.getInstance()
export default miniappCatalog
