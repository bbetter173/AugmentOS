import CoreModule from "core"
import type {OtaProgress, OtaStatus} from "core"
import {useCallback, useEffect, useRef, useState} from "react"
import {View, ActivityIndicator} from "react-native"

import {
  DOWNLOAD_STUCK_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  MAX_RETRIES,
  MTK_INSTALL_TIMEOUT_MS,
  OtaProgressMessages,
  PING_INTERVAL_MS,
  POST_APK_OTA_START_DELAY_MS,
  PROGRESS_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
} from "@/app/ota/otaProgressTimeouts"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import {useGlassesStore} from "@/stores/glasses"
import {getOtaErrorMessage} from "@/utils/otaErrorMapping"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

type DisplayState =
  | "starting"
  | "updating"
  | "complete"
  | "failed"
  | "disconnected"
  /** BES install finished; glasses are rebooting — expected BLE drop, show "Update Installed" + Continue */
  | "restarting"

// OtaSessionManager was introduced in build 36. Glasses on older builds use progress-legacy.tsx.
const MINIMUM_OTA_STATUS_BUILD = 36

const getErrorMessage = getOtaErrorMessage

function terminalForGlobalTimeoutClear(d: DisplayState): boolean {
  return d === "complete" || d === "failed" || d === "disconnected" || d === "restarting"
}

/** Non-empty when glasses are actively reporting work — drives stall timeout reset. */
function buildProgressStalenessSignature(
  otaStatus: OtaStatus | null,
  otaProgress: OtaProgress | null,
  displayState: DisplayState,
): string {
  if (
    displayState === "restarting" ||
    displayState === "complete" ||
    displayState === "failed" ||
    displayState === "disconnected"
  ) {
    return ""
  }
  if (otaStatus && (otaStatus.status === "in_progress" || otaStatus.status === "step_complete")) {
    return `s:${otaStatus.sessionId}|${otaStatus.status}|${otaStatus.phase}|${otaStatus.stepType}|${otaStatus.stepPercent}|${otaStatus.overallPercent}`
  }
  if (otaProgress && (otaProgress.status === "PROGRESS" || otaProgress.status === "STARTED")) {
    return `p:${otaProgress.currentUpdate}|${otaProgress.stage}|${otaProgress.status}|${otaProgress.progress}`
  }
  return ""
}

function progressTimeoutDurationMs(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): number {
  if (otaStatus?.stepType === "mtk" && otaStatus.phase === "install") return MTK_INSTALL_TIMEOUT_MS
  if (otaProgress?.currentUpdate === "mtk" && otaProgress.stage === "install") return MTK_INSTALL_TIMEOUT_MS
  return PROGRESS_TIMEOUT_MS
}

function latestPercentForStuck(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): number {
  if (otaProgress?.progress != null) return otaProgress.progress
  if (otaStatus?.status === "in_progress" || otaStatus?.status === "step_complete") {
    return Math.max(otaStatus.overallPercent ?? 0, otaStatus.stepPercent ?? 0)
  }
  return 0
}

export default function OtaProgressScreen() {
  const {theme} = useAppTheme()
  const {replace} = useNavigationHistory()
  const connected = useGlassesStore((s) => s.connected)
  const currentBuildNumber = useGlassesStore((s) => s.buildNumber)
  const otaStatus = useGlassesStore((s) => s.otaStatus)
  const otaProgress = useGlassesStore((s) => s.otaProgress)

  const [displayState, setDisplayState] = useState<DisplayState>("starting")
  const [errorMsg, setErrorMsg] = useState("")

  const displayStateRef = useRef<DisplayState>(displayState)
  useEffect(() => {
    displayStateRef.current = displayState
  }, [displayState])

  const sessionStarted = useRef(false)
  const wasConnected = useRef(connected)
  const wasBesUpdateRef = useRef(false)
  const sawDisconnectDuringRestartRef = useRef(false)
  const besLastStatusRef = useRef<"step_complete" | "complete" | null>(null)

  const globalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalTimeoutStartedRef = useRef(false)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stuckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const postApkDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const hasReceivedAckRef = useRef(false)
  const hasFirstActivityRef = useRef(false)
  const retryCountRef = useRef(0)
  /** APK step finished with more steps to go — next ota_start after BLE reconnect uses POST_APK delay */
  const postApkAwaitingReconnectRef = useRef(false)
  const latestOtaStatusRef = useRef<OtaStatus | null>(null)
  const latestOtaProgressRef = useRef<OtaProgress | null>(null)

  useEffect(() => {
    latestOtaStatusRef.current = otaStatus
  }, [otaStatus])
  useEffect(() => {
    latestOtaProgressRef.current = otaProgress
  }, [otaProgress])

  const [continueButtonDisabled, setContinueButtonDisabled] = useState(false)

  focusEffectPreventBack()

  const isFirmwareCompleting = wasBesUpdateRef.current && !connected && displayState === "restarting"

  const {setConfig, clearConfig} = useConnectionOverlayConfig()
  useEffect(() => {
    if (isFirmwareCompleting) {
      setConfig({
        customTitle: "Please wait while Mentra Live restarts and automatically reconnects...",
        customMessage: "",
        hideStopButton: true,
        smallTitle: true,
        suppressOverlay: false,
      })
    } else {
      setConfig({suppressOverlay: true})
    }
    return () => clearConfig()
  }, [isFirmwareCompleting, setConfig, clearConfig])

  const buildNum = parseInt(currentBuildNumber || "0", 10)
  useEffect(() => {
    if (buildNum > 0 && buildNum < MINIMUM_OTA_STATUS_BUILD) {
      replace("/ota/progress-legacy")
    }
  }, [buildNum, replace])

  const clearProgressTimeout = useCallback(() => {
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current)
      progressTimeoutRef.current = null
    }
  }, [])

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  const clearStuckTimeout = useCallback(() => {
    if (stuckTimeoutRef.current) {
      clearTimeout(stuckTimeoutRef.current)
      stuckTimeoutRef.current = null
    }
  }, [])

  const clearGlobalTimeout = useCallback(() => {
    if (globalTimeoutRef.current) {
      clearTimeout(globalTimeoutRef.current)
      globalTimeoutRef.current = null
    }
    globalTimeoutStartedRef.current = false
  }, [])

  const clearPostApkDelay = useCallback(() => {
    if (postApkDelayRef.current) {
      clearTimeout(postApkDelayRef.current)
      postApkDelayRef.current = null
    }
  }, [])

  const clearPingInterval = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
  }, [])

  const clearPerStepTimers = useCallback(() => {
    clearRetryTimeout()
    clearStuckTimeout()
    clearProgressTimeout()
    clearPostApkDelay()
  }, [clearProgressTimeout, clearPostApkDelay, clearRetryTimeout, clearStuckTimeout])

  const clearAllOtaTimers = useCallback(() => {
    clearPerStepTimers()
    clearGlobalTimeout()
    clearPingInterval()
  }, [clearGlobalTimeout, clearPerStepTimers, clearPingInterval])

  const onFirstActivity = useCallback(() => {
    if (hasFirstActivityRef.current) return
    hasFirstActivityRef.current = true
    clearRetryTimeout()
    clearStuckTimeout()
  }, [clearRetryTimeout, clearStuckTimeout])

  const maybeStartGlobalTimeout = useCallback(() => {
    if (globalTimeoutStartedRef.current) return
    globalTimeoutStartedRef.current = true
    globalTimeoutRef.current = setTimeout(() => {
      globalTimeoutRef.current = null
      globalTimeoutStartedRef.current = false
      const d = displayStateRef.current
      if (terminalForGlobalTimeoutClear(d)) return
      clearPerStepTimers()
      setErrorMsg(OtaProgressMessages.globalTimeout)
      setDisplayState("failed")
    }, GLOBAL_OTA_TIMEOUT_MS)
  }, [clearPerStepTimers])

  const sendOtaStartRef = useRef<() => Promise<void>>(async () => {})

  const armAckAndStuckWatchdogsOnly = useCallback(() => {
    clearRetryTimeout()
    clearStuckTimeout()

    retryTimeoutRef.current = setTimeout(() => {
      retryTimeoutRef.current = null
      if (hasReceivedAckRef.current || hasFirstActivityRef.current) return
      if (displayStateRef.current !== "starting") return
      if (retryCountRef.current < MAX_RETRIES - 1) {
        retryCountRef.current += 1
        hasReceivedAckRef.current = false
        void CoreModule.sendOtaStart()
          .then(() => {
            armAckAndStuckWatchdogsOnly()
          })
          .catch(() => {})
      } else {
        setErrorMsg(OtaProgressMessages.noAckResponse)
        setDisplayState("failed")
      }
    }, RETRY_INTERVAL_MS)

    stuckTimeoutRef.current = setTimeout(() => {
      stuckTimeoutRef.current = null
      const d = displayStateRef.current
      if (d !== "starting" && !(d === "updating" && latestOtaStatusRef.current?.phase === "download")) {
        return
      }
      const pct = latestPercentForStuck(latestOtaStatusRef.current, latestOtaProgressRef.current)
      if (pct !== 0) return
      clearRetryTimeout()
      setErrorMsg(OtaProgressMessages.stalledOrStuck)
      setDisplayState("failed")
    }, DOWNLOAD_STUCK_TIMEOUT_MS)
  }, [clearRetryTimeout, clearStuckTimeout])

  const sendOtaStartWithWatchdogs = useCallback(async () => {
    maybeStartGlobalTimeout()
    hasReceivedAckRef.current = false
    armAckAndStuckWatchdogsOnly()
    try {
      await CoreModule.sendOtaStart()
    } catch {
      clearRetryTimeout()
      clearStuckTimeout()
      if (retryCountRef.current < MAX_RETRIES - 1) {
        retryCountRef.current += 1
        retryTimeoutRef.current = setTimeout(() => {
          retryTimeoutRef.current = null
          void sendOtaStartRef.current()
        }, RETRY_INTERVAL_MS)
      } else {
        setErrorMsg(OtaProgressMessages.sendOtaStartFailed)
        setDisplayState("failed")
      }
    }
  }, [armAckAndStuckWatchdogsOnly, clearRetryTimeout, clearStuckTimeout, maybeStartGlobalTimeout])

  sendOtaStartRef.current = sendOtaStartWithWatchdogs

  useEffect(() => {
    if (!connected) {
      clearPostApkDelay()
      wasConnected.current = false
      return
    }

    const becameConnected = !wasConnected.current && connected
    wasConnected.current = connected

    if (becameConnected && postApkAwaitingReconnectRef.current) {
      postApkAwaitingReconnectRef.current = false
      clearPostApkDelay()
      postApkDelayRef.current = setTimeout(() => {
        postApkDelayRef.current = null
        retryCountRef.current = 0
        hasFirstActivityRef.current = false
        hasReceivedAckRef.current = false
        void sendOtaStartWithWatchdogs()
      }, POST_APK_OTA_START_DELAY_MS)
    } else {
      if (becameConnected) {
        void CoreModule.sendOtaQueryStatus()
      } else if (!sessionStarted.current) {
        retryCountRef.current = 0
        hasFirstActivityRef.current = false
        hasReceivedAckRef.current = false
        void sendOtaStartWithWatchdogs()
      } else {
        void CoreModule.sendOtaQueryStatus()
      }
    }
  }, [connected, sendOtaStartWithWatchdogs, clearPostApkDelay])

  useEffect(() => {
    if (terminalForGlobalTimeoutClear(displayState)) {
      clearGlobalTimeout()
    }
  }, [displayState, clearGlobalTimeout])

  useEffect(() => {
    const handleAck = () => {
      if (hasReceivedAckRef.current) return
      hasReceivedAckRef.current = true
      clearRetryTimeout()
    }
    const handleMtkComplete = () => {
      clearProgressTimeout()
      onFirstActivity()
      void CoreModule.sendOtaQueryStatus()
      useGlassesStore.getState().setMtkUpdatedThisSession(true)
    }
    GlobalEventEmitter.on("ota_start_ack", handleAck)
    GlobalEventEmitter.on("mtk_update_complete", handleMtkComplete)
    return () => {
      GlobalEventEmitter.off("ota_start_ack", handleAck)
      GlobalEventEmitter.off("mtk_update_complete", handleMtkComplete)
    }
  }, [clearProgressTimeout, clearRetryTimeout, onFirstActivity])

  useEffect(() => {
    const active = connected && (displayState === "starting" || displayState === "updating")
    if (active) {
      void CoreModule.ping().catch(() => {})
      pingIntervalRef.current = setInterval(() => {
        void CoreModule.ping().catch(() => {})
      }, PING_INTERVAL_MS)
      return () => {
        clearPingInterval()
      }
    }
    clearPingInterval()
    return undefined
  }, [connected, displayState, clearPingInterval])

  useEffect(() => {
    if (!otaStatus) {
      return
    }
    if (postApkAwaitingReconnectRef.current && connected && otaStatus.stepType === "mtk") {
      postApkAwaitingReconnectRef.current = false
    }

    if (otaStatus.stepType === "apk" && otaStatus.totalSteps > 1) {
      if (otaStatus.status === "complete" || otaStatus.status === "step_complete") {
        postApkAwaitingReconnectRef.current = true
      }
    }

    const statusShowsWork =
      otaStatus.status === "in_progress" ||
      otaStatus.status === "step_complete" ||
      otaStatus.status === "complete" ||
      otaStatus.status === "failed"
    if (statusShowsWork) {
      sessionStarted.current = true
      onFirstActivity()
    }

    if (otaStatus.stepType === "bes" && (otaStatus.status === "step_complete" || otaStatus.status === "complete")) {
      sessionStarted.current = true
      wasBesUpdateRef.current = true
      besLastStatusRef.current = otaStatus.status
      setDisplayState("restarting")
      return
    }

    switch (otaStatus.status) {
      case "in_progress":
      case "step_complete":
        setDisplayState("updating")
        break
      case "complete":
        setDisplayState("complete")
        break
      case "failed":
        setErrorMsg(getErrorMessage(otaStatus.error))
        setDisplayState("failed")
        break
      default:
        break
    }
  }, [otaStatus, onFirstActivity, connected])

  useEffect(() => {
    if (otaProgress?.currentUpdate !== "bes") return
    if (otaProgress.stage !== "install") return
    wasBesUpdateRef.current = true
    sessionStarted.current = true
    onFirstActivity()
    if (otaProgress.status === "PROGRESS" || otaProgress.status === "STARTED") {
      // BES sr_adota path — counts as activity for ack/stuck
    }
    if (otaProgress.status === "FINISHED") {
      besLastStatusRef.current = "complete"
      setDisplayState("restarting")
    }
  }, [otaProgress, onFirstActivity])

  useEffect(() => {
    if (
      displayState === "restarting" ||
      displayState === "complete" ||
      displayState === "failed" ||
      displayState === "disconnected"
    ) {
      clearProgressTimeout()
      return
    }
    const sig = buildProgressStalenessSignature(otaStatus, otaProgress, displayState)
    if (!sig) {
      clearProgressTimeout()
      return
    }
    const duration = progressTimeoutDurationMs(otaStatus, otaProgress)
    clearProgressTimeout()
    progressTimeoutRef.current = setTimeout(() => {
      progressTimeoutRef.current = null
      if (terminalForGlobalTimeoutClear(displayStateRef.current)) return
      setErrorMsg(OtaProgressMessages.stalledOrStuck)
      setDisplayState("failed")
    }, duration)
    return () => {
      clearProgressTimeout()
    }
  }, [otaStatus, otaProgress, displayState, clearProgressTimeout])

  useEffect(() => {
    if (!connected && displayState !== "complete" && displayState !== "failed") {
      if (displayState === "restarting" || wasBesUpdateRef.current) {
        sawDisconnectDuringRestartRef.current = true
        setDisplayState("restarting")
      } else {
        setDisplayState("disconnected")
      }
    }
    if (connected && displayState === "disconnected") {
      setDisplayState(sessionStarted.current ? "updating" : "starting")
    }
  }, [connected, displayState])

  useEffect(() => {
    if (displayState !== "restarting") return
    if (!connected) return
    if (!sawDisconnectDuringRestartRef.current) return

    if (besLastStatusRef.current === "complete") {
      setDisplayState("complete")
    } else {
      void CoreModule.sendOtaQueryStatus()
    }
  }, [connected, displayState])

  useEffect(() => {
    if (displayState !== "restarting" || !wasBesUpdateRef.current) return
    setContinueButtonDisabled(true)
    const t = setTimeout(() => setContinueButtonDisabled(false), 15_000)
    return () => clearTimeout(t)
  }, [displayState])

  useEffect(() => {
    return () => {
      clearAllOtaTimers()
    }
  }, [clearAllOtaTimers])

  useEffect(() => {
    if (displayState === "failed") {
      clearPerStepTimers()
    }
  }, [displayState, clearPerStepTimers])

  const handleContinue = () => {
    replace("/ota/check-for-updates")
  }

  const handleRetry = () => {
    clearPerStepTimers()
    retryCountRef.current = 0
    hasFirstActivityRef.current = false
    hasReceivedAckRef.current = false
    sessionStarted.current = false
    setDisplayState("starting")
    setErrorMsg("")
    useGlassesStore.getState().setOtaStatus(null)
    if (connected) {
      void sendOtaStartWithWatchdogs()
    }
  }

  const handleDone = () => {
    replace("/ota/check-for-updates")
  }

  const renderContent = () => {
    if (displayState === "starting") {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text text="Starting update..." className="font-semibold text-xl text-center" />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <View className="h-4" />
          <Text
            text="Do not disconnect your glasses"
            className="text-sm text-center"
            style={{color: theme.colors.textDim}}
          />
        </View>
      )
    }

    if (displayState === "updating") {
      const isDownload = otaStatus?.phase === "download"
      const totalSteps = otaStatus?.totalSteps ?? 1
      const isApkOnlyInstalling = otaStatus?.stepType === "apk" && otaStatus?.phase === "install" && totalSteps === 1

      const rawPercent = isDownload
        ? (otaStatus?.stepPercent ?? 0)
        : totalSteps >= 2
          ? (otaStatus?.overallPercent ?? 0)
          : (otaStatus?.stepPercent ?? 0)
      const percent = Math.min(Math.max(rawPercent, 0), 100)

      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text
            text={otaStatus?.phase === "download" ? "Downloading..." : "Installing..."}
            className="font-semibold text-xl text-center"
          />
          <View className="h-4" />
          {isApkOnlyInstalling ? (
            <ActivityIndicator size="large" color={theme.colors.foreground} />
          ) : (
            <>
              <Text
                text={`${Math.round(percent)}%`}
                className="text-3xl font-bold"
                style={{color: theme.colors.primary}}
              />
              <View className="h-4" />
              <View className="w-full h-2 rounded-full overflow-hidden" style={{backgroundColor: theme.colors.border}}>
                <View
                  className="h-full rounded-full"
                  style={{backgroundColor: theme.colors.primary, width: `${percent}%`}}
                />
              </View>
            </>
          )}
          <View className="h-4" />
          <Text
            text="Do not disconnect your glasses"
            className="text-sm text-center"
            style={{color: theme.colors.textDim}}
          />
        </View>
      )
    }

    if (displayState === "restarting") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text="Update Installed" className="font-semibold text-xl text-center" />
          </View>
          <View className="justify-center items-center">
            <Button
              preset="primary"
              text="Continue"
              flexContainer
              onPress={handleContinue}
              disabled={continueButtonDisabled}
            />
          </View>
        </>
      )
    }

    if (displayState === "complete") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text="Update complete!" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text
              text="Your glasses are up to date."
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          </View>
          <View className="justify-center items-center">
            <Button preset="primary" text="Done" flexContainer onPress={handleDone} />
          </View>
        </>
      )
    }

    if (displayState === "failed") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="alert" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text="Update Failed" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text text={errorMsg} className="text-sm text-center text-secondary-foreground" />
          </View>
          <View className="gap-3">
            <Button preset="primary" text="Retry" flexContainer onPress={handleRetry} />
          </View>
        </>
      )
    }

    return (
      <View className="flex-1 items-center justify-center px-6">
        <Icon name="bluetooth-off" size={64} color={theme.colors.error} />
        <View className="h-6" />
        <Text text="Glasses disconnected" className="font-semibold text-xl text-center" />
        <View className="h-2" />
        <Text text="Reconnecting..." className="text-sm text-center" style={{color: theme.colors.textDim}} />
        <View className="h-4" />
        <ActivityIndicator size="large" color={theme.colors.foreground} />
      </View>
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header RightActionComponent={<MentraLogoStandalone />} />
      {renderContent()}
    </Screen>
  )
}
