import {useEffect} from "react"
import {AppState} from "react-native"

import {useStressTestStore} from "@/stores/stressTest"

/**
 * Listens for iOS memoryWarning events from the OS. RN translates iOS's
 * `applicationDidReceiveMemoryWarning` into AppState's "memoryWarning" event.
 *
 * For now this is purely observational — we record it in the stress-test
 * store and emit a STRESS: log line. We deliberately do NOT evict any
 * miniapp WebViews here, because product wants miniapps persistent in the
 * background while glasses are connected. The point of the stress test is
 * to find out whether persistent WebViews can survive at all under iOS
 * jetsam pressure.
 */
export function MemoryWarningMonitor() {
  useEffect(() => {
    const sub = AppState.addEventListener("memoryWarning", () => {
      useStressTestStore.getState().recordEvent({
        packageName: "__host__",
        at: Date.now(),
        kind: "memwarn",
      })
    })
    return () => sub.remove()
  }, [])
  return null
}
