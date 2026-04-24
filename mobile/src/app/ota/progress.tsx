import CoreModule from "core"
import type {OtaProgress, OtaStatus} from "core"
import {useCallback, useEffect, useRef, useState} from "react"
import {View, ActivityIndicator} from "react-native"

import {deriveDisplayState, type DisplayState} from "@/app/ota/deriveOtaDisplayState"
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

// OtaSessionManager was introduced in build 36. Older builds use progress-legacy.tsx.
const MINIMUM_OTA_STATUS_BUILD = 36

function isTerminalForWatchdog(d: DisplayState): boolean {
  return d === "complete" || d === "failed" || d === "restarting"
}

/** Non-empty when glasses are actively reporting work — drives stall timeout reset. */
function buildProgressStalenessSignature(
  otaStatus: OtaStatus | null,
  otaProgress: OtaProgress | null,
  displayState: DisplayState,
): string {
  if (displayState !== "starting" && displayState !== "updating") return ""
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

  // Genuinely local UI state
  const [errorMsg, setErrorMsg] = useState("")
  const [sawReconnectEdge, setSawReconnectEdge] = useState(false)
  const [continueButtonDisabled, setContinueButtonDisabled] = useState(false)

  // Ref mirrors for synchronous reads inside setTimeout callbacks.
  const errorMsgRef = useRef(errorMsg)
  useEffect(() => {
    errorMsgRef.current = errorMsg
  }, [errorMsg])
  const sawReconnectEdgeRef = useRef(sawReconnectEdge)
  useEffect(() => {
    sawReconnectEdgeRef.current = sawReconnectEdge
  }, [sawReconnectEdge])

  const prevConnectedRef = useRef(connected)

  // Timer handles
  const globalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalTimeoutStartedRef = useRef(false)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stuckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const postApkDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Retry / ack bookkeeping (no glasses source)
  const hasReceivedAckRef = useRef(false)
  const hasFirstActivityRef = useRef(false)
  const retryCountRef = useRef(0)

  focusEffectPreventBack()

  // Derived UI state — the glasses data IS the source of truth.
  const displayState = deriveDisplayState({
    otaStatus,
    otaProgress,
    connected,
    errorMsg,
    sawReconnectEdge,
  })

  // Log displayState transitions only (not every render).
  const prevDisplayStateRef = useRef<DisplayState | null>(null)
  if (prevDisplayStateRef.current !== displayState) {
    console.log(
      `[OTA_PROGRESS] displayState ${prevDisplayStateRef.current ?? "<init>"} -> ${displayState}`,
      JSON.stringify({
        connected,
        sawReconnectEdge,
        errorMsg: errorMsg || null,
        otaStatus: otaStatus
          ? {
              stepType: otaStatus.stepType,
              phase: otaStatus.phase,
              status: otaStatus.status,
              step: `${otaStatus.currentStep}/${otaStatus.totalSteps}`,
              pct: otaStatus.overallPercent,
            }
          : null,
        otaProgress: otaProgress
          ? {
              currentUpdate: otaProgress.currentUpdate,
              stage: otaProgress.stage,
              status: otaProgress.status,
              progress: otaProgress.progress,
            }
          : null,
      }),
    )
    prevDisplayStateRef.current = displayState
  }

  const isFirmwareCompleting = !connected && displayState === "restarting"

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

  // --- Timer cleanup helpers ---

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

  /**
   * Read the current derived display state from the store + ref mirrors
   * synchronously — used inside setTimeout callbacks where we cannot use
   * the render-time `displayState`.
   */
  const computeDisplayStateNow = useCallback((): DisplayState => {
    const s = useGlassesStore.getState()
    return deriveDisplayState({
      otaStatus: s.otaStatus,
      otaProgress: s.otaProgress,
      connected: s.connected,
      errorMsg: errorMsgRef.current,
      sawReconnectEdge: sawReconnectEdgeRef.current,
    })
  }, [])

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
      if (isTerminalForWatchdog(computeDisplayStateNow())) return
      console.log("[OTA_PROGRESS] watchdog: global timeout fired, failing session")
      clearPerStepTimers()
      setErrorMsg(OtaProgressMessages.globalTimeout)
    }, GLOBAL_OTA_TIMEOUT_MS)
  }, [clearPerStepTimers, computeDisplayStateNow])

  const sendOtaStartRef = useRef<() => Promise<void>>(async () => {})

  const armAckAndStuckWatchdogsOnly = useCallback(() => {
    clearRetryTimeout()
    clearStuckTimeout()

    retryTimeoutRef.current = setTimeout(() => {
      retryTimeoutRef.current = null
      if (hasReceivedAckRef.current || hasFirstActivityRef.current) return
      if (computeDisplayStateNow() !== "starting") return
      if (retryCountRef.current < MAX_RETRIES - 1) {
        retryCountRef.current += 1
        hasReceivedAckRef.current = false
        console.log(
          `[OTA_PROGRESS] watchdog: no ack in ${RETRY_INTERVAL_MS}ms, retrying ota_start (attempt ${retryCountRef.current})`,
        )
        void CoreModule.sendOtaStart()
          .then(() => {
            armAckAndStuckWatchdogsOnly()
          })
          .catch(() => {})
      } else {
        console.log(`[OTA_PROGRESS] watchdog: ota_start ack never received after ${MAX_RETRIES} attempts, failing`)
        setErrorMsg(OtaProgressMessages.noAckResponse)
      }
    }, RETRY_INTERVAL_MS)

    stuckTimeoutRef.current = setTimeout(() => {
      stuckTimeoutRef.current = null
      const d = computeDisplayStateNow()
      const s = useGlassesStore.getState()
      if (d !== "starting" && !(d === "updating" && s.otaStatus?.phase === "download")) {
        return
      }
      const pct = latestPercentForStuck(s.otaStatus, s.otaProgress)
      if (pct !== 0) return
      console.log(`[OTA_PROGRESS] watchdog: stuck at 0% for ${DOWNLOAD_STUCK_TIMEOUT_MS}ms, failing`)
      clearRetryTimeout()
      setErrorMsg(OtaProgressMessages.stalledOrStuck)
    }, DOWNLOAD_STUCK_TIMEOUT_MS)
  }, [clearRetryTimeout, clearStuckTimeout, computeDisplayStateNow])

  const sendOtaStartWithWatchdogs = useCallback(async () => {
    maybeStartGlobalTimeout()
    hasReceivedAckRef.current = false
    armAckAndStuckWatchdogsOnly()
    try {
      await CoreModule.sendOtaStart()
    } catch (err) {
      console.warn("[OTA_PROGRESS] sendOtaStart threw", err)
      clearRetryTimeout()
      clearStuckTimeout()
      if (retryCountRef.current < MAX_RETRIES - 1) {
        retryCountRef.current += 1
        retryTimeoutRef.current = setTimeout(() => {
          retryTimeoutRef.current = null
          void sendOtaStartRef.current()
        }, RETRY_INTERVAL_MS)
      } else {
        console.log("[OTA_PROGRESS] sendOtaStart failed after max retries, failing session")
        setErrorMsg(OtaProgressMessages.sendOtaStartFailed)
      }
    }
  }, [armAckAndStuckWatchdogsOnly, clearRetryTimeout, clearStuckTimeout, maybeStartGlobalTimeout])

  sendOtaStartRef.current = sendOtaStartWithWatchdogs

  /**
   * Connect-edge effect — the only place that decides to send ota_start /
   * ota_query_status, handles POST_APK delay, and flips sawReconnectEdge
   * on the false -> true transition that signals the BES reboot completed.
   */
  useEffect(() => {
    const prev = prevConnectedRef.current
    prevConnectedRef.current = connected

    if (!connected) {
      console.log("[OTA_PROGRESS] connect-edge: disconnected")
      clearPostApkDelay()
      return
    }

    const becameConnected = prev === false && connected === true
    if (becameConnected) {
      console.log("[OTA_PROGRESS] connect-edge: false->true, flipping sawReconnectEdge=true")
      setSawReconnectEdge(true)
    }

    const storeSnapshot = useGlassesStore.getState()
    const s = storeSnapshot.otaStatus
    const postApkAwaiting =
      s?.stepType === "apk" && (s?.totalSteps ?? 0) > 1 && (s.status === "step_complete" || s.status === "complete")

    if (becameConnected && postApkAwaiting) {
      console.log("[OTA_PROGRESS] connect-edge: post-APK reboot detected, arming POST_APK delay for sendOtaStart")
      clearPostApkDelay()
      postApkDelayRef.current = setTimeout(() => {
        postApkDelayRef.current = null
        retryCountRef.current = 0
        hasFirstActivityRef.current = false
        hasReceivedAckRef.current = false
        console.log("[OTA_PROGRESS] POST_APK delay fired, sending ota_start")
        void sendOtaStartWithWatchdogs()
      }, POST_APK_OTA_START_DELAY_MS)
      return
    }

    if (becameConnected) {
      console.log("[OTA_PROGRESS] connect-edge: reconnected, sending ota_query_status")
      void CoreModule.sendOtaQueryStatus()
      return
    }

    // Initial mount (prev === current === true). If no session yet, kick off ota_start.
    const noSessionYet = !storeSnapshot.otaStatus && !storeSnapshot.otaProgress
    if (noSessionYet) {
      console.log("[OTA_PROGRESS] initial mount, no session in store, sending ota_start")
      retryCountRef.current = 0
      hasFirstActivityRef.current = false
      hasReceivedAckRef.current = false
      void sendOtaStartWithWatchdogs()
    } else {
      console.log("[OTA_PROGRESS] initial mount, session exists, sending ota_query_status")
      void CoreModule.sendOtaQueryStatus()
    }
  }, [connected, sendOtaStartWithWatchdogs, clearPostApkDelay])

  useEffect(() => {
    if (isTerminalForWatchdog(displayState)) {
      clearGlobalTimeout()
    }
  }, [displayState, clearGlobalTimeout])

  useEffect(() => {
    const handleAck = () => {
      if (hasReceivedAckRef.current) return
      console.log("[OTA_PROGRESS] ota_start_ack received")
      hasReceivedAckRef.current = true
      clearRetryTimeout()
    }
    const handleMtkComplete = () => {
      console.log("[OTA_PROGRESS] mtk_update_complete received")
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

  // Ping keepalive while an OTA is actively running
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

  // First glasses activity clears the "no-ack / stuck-at-zero" watchdogs.
  useEffect(() => {
    if (otaStatus || otaProgress) {
      onFirstActivity()
    }
  }, [otaStatus, otaProgress, onFirstActivity])

  // Progress stall watchdog — fails the update if glasses go silent mid-step.
  useEffect(() => {
    if (displayState !== "starting" && displayState !== "updating") {
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
      if (isTerminalForWatchdog(computeDisplayStateNow())) return
      console.log(`[OTA_PROGRESS] watchdog: progress stalled for ${duration}ms, failing`)
      setErrorMsg(OtaProgressMessages.stalledOrStuck)
    }, duration)
    return () => {
      clearProgressTimeout()
    }
  }, [otaStatus, otaProgress, displayState, clearProgressTimeout, computeDisplayStateNow])

  // 15s lockout on Continue button after BES restart to prevent accidental tap.
  useEffect(() => {
    if (displayState !== "restarting") return
    setContinueButtonDisabled(true)
    const t = setTimeout(() => setContinueButtonDisabled(false), 15_000)
    return () => clearTimeout(t)
  }, [displayState])

  useEffect(() => {
    if (displayState === "failed") {
      clearPerStepTimers()
    }
  }, [displayState, clearPerStepTimers])

  useEffect(() => {
    return () => {
      clearAllOtaTimers()
    }
  }, [clearAllOtaTimers])

  const handleContinue = () => {
    replace("/ota/check-for-updates")
  }

  const handleRetry = () => {
    console.log("[OTA_PROGRESS] retry pressed, clearing state and re-sending ota_start")
    clearPerStepTimers()
    retryCountRef.current = 0
    hasFirstActivityRef.current = false
    hasReceivedAckRef.current = false
    setSawReconnectEdge(false)
    setErrorMsg("")
    const store = useGlassesStore.getState()
    store.setOtaStatus(null)
    store.setOtaProgress(null)
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
      const displayedError = errorMsg || getOtaErrorMessage(otaStatus?.error)
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="alert" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text="Update Failed" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text text={displayedError} className="text-sm text-center text-secondary-foreground" />
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
