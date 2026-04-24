// until https://github.com/tconns/react-native-nitro-bg-timer/issues/2 is resolved, we need to use this class to disable this package on iOS:
// Guard: NitroTimer can be undefined if native module isn't ready yet (e.g. bridge init), so we fall back to JS timers.

import {Platform} from "react-native"

let NitroTimer: typeof import("react-native-nitro-bg-timer").BackgroundTimer | undefined
try {
  NitroTimer = require("react-native-nitro-bg-timer").BackgroundTimer
} catch {
  NitroTimer = undefined
}

const shouldUseNitroOnAndroid = (): boolean =>
  Platform.OS === "android" && NitroTimer != null && typeof NitroTimer.setTimeout === "function"

export class BackgroundTimer {
  static setInterval(callback: () => void, delay: number): number {
    if (shouldUseNitroOnAndroid()) {
      return NitroTimer!.setInterval(callback, delay)
    }
    return setInterval(callback, delay) as unknown as number
  }

  static clearInterval(intervalId: number): void {
    if (shouldUseNitroOnAndroid()) {
      NitroTimer!.clearInterval(intervalId)
    } else {
      clearInterval(intervalId)
    }
  }

  static setTimeout(callback: () => void, delay: number): number {
    if (shouldUseNitroOnAndroid()) {
      return NitroTimer!.setTimeout(callback, delay)
    }
    return setTimeout(callback, delay) as unknown as number
  }

  static clearTimeout(timeoutId: number): void {
    if (shouldUseNitroOnAndroid()) {
      NitroTimer!.clearTimeout(timeoutId)
    } else {
      clearTimeout(timeoutId)
    }
  }
}

export function throttle<T extends (...args: any[]) => void>(func: T, waitMs: number): T {
  let lastCallMs = 0
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let trailingArgs: Parameters<T> | null = null

  const invoke = (args: Parameters<T>) => {
    lastCallMs = Date.now()
    func(...args)
  }

  return ((...args: Parameters<T>) => {
    const now = Date.now()
    const remaining = waitMs - (now - lastCallMs)

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      trailingArgs = null
      invoke(args)
      return
    }

    trailingArgs = args
    if (!timeoutId) {
      timeoutId = setTimeout(() => {
        timeoutId = null
        if (trailingArgs) {
          invoke(trailingArgs)
          trailingArgs = null
        }
      }, remaining)
    }
  }) as T
}
