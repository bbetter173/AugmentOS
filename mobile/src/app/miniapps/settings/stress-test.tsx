import {useEffect, useRef, useState} from "react"
import {ScrollView, View, Text} from "react-native"
import {useLocalSearchParams} from "expo-router"

import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {useNavigationStore} from "@/stores/navigation"
import {useStressTestStore} from "@/stores/stressTest"
import {buildDummyMiniappHtml} from "@/utils/stressTest/dummyHtml"
import CoreModule from "@mentra/bluetooth-sdk"
import {miniappRunningRegistry} from "@mentra/island"

const DUMMY_PREFIX = "com.mentra.stress.dummy."
const DEFAULT_MB_PER_APP = 25
const POLL_MS = 1000

function dataUriFor(packageName: string, mb: number): string {
  const html = buildDummyMiniappHtml(packageName, mb)
  // base64 keeps things robust vs URL-encoding the % signs in the HTML
  // eslint-disable-next-line no-undef
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(html)))
      : Buffer.from(html, "utf8").toString("base64")
  return `data:text/html;base64,${b64}`
}

export default function StressTest() {
  const {goBack} = useNavigationStore.getState()
  const {active, events, residentMB, memWarnCount, start, stop, setResidentMB} = useStressTestStore()
  const [mountedCount, setMountedCount] = useState(0)
  const params = useLocalSearchParams<{autorun?: string; mb?: string; n?: string}>()
  const initialMb = params.mb ? Math.max(1, parseInt(params.mb, 10)) : DEFAULT_MB_PER_APP
  const [mbPerApp, setMbPerApp] = useState(initialMb)
  const counterRef = useRef(0)
  const autoranRef = useRef(false)

  // Memory poll loop
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      try {
        const mb = CoreModule.getMemoryMB()
        setResidentMB(mb)
        if (active) {
          // Single-line structured log so the CLI driver can grep
          // STRESS: lines out of `log stream` reliably.
          // eslint-disable-next-line no-console
          console.log(
            `STRESS: sample ${JSON.stringify({
              at: Date.now(),
              residentMB: mb,
              mounted: mountedCount,
              terminated: events.filter((e) => e.kind === "terminate").length,
              memwarn: memWarnCount,
            })}`,
          )
        }
      } catch {
        // ignore — module may not be loaded on Android
      }
    }
    tick()
    id = setInterval(tick, POLL_MS)
    return () => {
      if (id) clearInterval(id)
    }
  }, [active, mountedCount, events, memWarnCount, setResidentMB])

  // Keep mountedCount in sync with the registry so jetsam-evicted entries
  // are reflected in the UI.
  useEffect(() => {
    const refresh = () => {
      setMountedCount(
        miniappRunningRegistry.getAll().filter((p) => p.startsWith(DUMMY_PREFIX)).length,
      )
    }
    refresh()
    const unsub = miniappRunningRegistry.subscribe(refresh)
    return unsub
  }, [])

  const mountOne = () => {
    counterRef.current += 1
    const pkg = `${DUMMY_PREFIX}${counterRef.current}`
    miniappHost.mount(pkg, dataUriFor(pkg, mbPerApp), {
      appName: `Dummy ${counterRef.current}`,
    })
    // eslint-disable-next-line no-console
    console.log(`STRESS: mount ${JSON.stringify({pkg, mb: mbPerApp, at: Date.now()})}`)
  }

  const mountN = (n: number) => {
    for (let i = 0; i < n; i += 1) mountOne()
  }

  // Autorun: when launched via deeplink with ?autorun=1&mb=X&n=Y, kick off
  // logging and mount N dummies automatically. Only fires once per mount of
  // this screen so backgrounding/foregrounding doesn't re-trigger.
  useEffect(() => {
    if (autoranRef.current) return
    if (params.autorun !== "1" && params.autorun !== "true") return
    autoranRef.current = true
    const n = params.n ? Math.max(1, parseInt(params.n, 10)) : 5
    // eslint-disable-next-line no-console
    console.log(`STRESS: autorun ${JSON.stringify({mb: initialMb, n, at: Date.now()})}`)
    start()
    // Stagger the mounts slightly so each WebView has a beat to allocate
    // before the next one starts. 200ms is enough for the data: URL to
    // begin loading without making the test feel slow.
    let i = 0
    const id = setInterval(() => {
      mountOne()
      i += 1
      if (i >= n) clearInterval(id)
    }, 200)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unmountAll = () => {
    miniappRunningRegistry.getAll()
      .filter((p) => p.startsWith(DUMMY_PREFIX))
      .forEach((p) => miniappHost.unmount(p))
    // eslint-disable-next-line no-console
    console.log("STRESS: unmount-all")
  }

  const terminated = events.filter((e) => e.kind === "terminate").length

  return (
    <Screen preset="fixed">
      <Header title="Stress Test" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-4 mt-6">
          <Group title="State">
            <View className="px-4 py-3">
              <Text className="text-text">Mounted dummies: {mountedCount}</Text>
              <Text className="text-text">Resident: {residentMB.toFixed(1)} MB</Text>
              <Text className="text-text">Terminated (jetsam): {terminated}</Text>
              <Text className="text-text">Memory warnings: {memWarnCount}</Text>
              <Text className="text-text">Logging active: {active ? "yes" : "no"}</Text>
              <Text className="text-text">MB per app: {mbPerApp}</Text>
            </View>
          </Group>

          <Group title="Logging">
            <RouteButton
              label={active ? "Stop logging" : "Start logging"}
              subtitle={active ? "Sampling and STRESS: lines flowing" : "Begin a test run (timestamps)"}
              onPress={() => (active ? stop() : start())}
            />
          </Group>

          <Group title="Per-app heap size">
            {[5, 25, 50, 100].map((mb) => (
              <RouteButton
                key={mb}
                label={`${mb} MB`}
                subtitle={mbPerApp === mb ? "selected" : ""}
                onPress={() => setMbPerApp(mb)}
              />
            ))}
          </Group>

          <Group title="Mount">
            <RouteButton label="Mount 1" onPress={() => mountOne()} />
            <RouteButton label="Mount 5" onPress={() => mountN(5)} />
            <RouteButton label="Mount 10" onPress={() => mountN(10)} />
            <RouteButton label="Mount 25" onPress={() => mountN(25)} />
          </Group>

          <Group title="Unmount">
            <RouteButton label="Unmount all dummies" onPress={() => unmountAll()} />
          </Group>

          <Group title="Recent events">
            <View className="px-4 py-3">
              {events
                .slice(-8)
                .reverse()
                .map((e, i) => (
                  <Text key={i} className="text-text text-xs">
                    {new Date(e.at).toLocaleTimeString()} {e.kind} {e.packageName}
                  </Text>
                ))}
              {events.length === 0 && <Text className="text-text text-xs">no events yet</Text>}
            </View>
          </Group>
        </View>
      </ScrollView>
    </Screen>
  )
}
