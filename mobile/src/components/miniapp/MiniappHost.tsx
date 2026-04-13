import {useEffect, useState, useCallback, useRef} from 'react'
import {View, StyleSheet, Alert, Platform} from 'react-native'
import {WebView, WebViewMessageEvent} from 'react-native-webview'

import localMiniappRuntime from '@/services/LocalMiniappRuntime'
import miniComms from '@/services/MiniComms'

const BEFORE_EVICT_TIMEOUT_MS = 500

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MountedMiniapp {
  packageName: string
  source: {uri: string} | {html: string}
  injectedJS: string
  isForeground: boolean
}

// ---------------------------------------------------------------------------
// Module-level singleton API
// ---------------------------------------------------------------------------

type MiniappHostAPI = {
  mount(packageName: string, bundleUri: string, injectedJS: string): void
  mountDev(packageName: string, devUrl: string, injectedJS: string): void
  unmount(packageName: string): void
  setForeground(packageName: string): void
  setBackground(packageName: string): void
  isRunning(packageName: string): boolean
}

// Stubs that get replaced once the React component mounts.
export const miniappHost: MiniappHostAPI = {
  mount: () => {
    console.warn('MiniappHost: mount() called before component mounted')
  },
  mountDev: () => {
    console.warn('MiniappHost: mountDev() called before component mounted')
  },
  unmount: () => {
    console.warn('MiniappHost: unmount() called before component mounted')
  },
  setForeground: () => {
    console.warn('MiniappHost: setForeground() called before component mounted')
  },
  setBackground: () => {
    console.warn('MiniappHost: setBackground() called before component mounted')
  },
  isRunning: () => false,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MiniappHost() {
  const [apps, setApps] = useState<Map<string, MountedMiniapp>>(new Map())
  const webViewRefs = useRef<Map<string, WebView>>(new Map())

  // -- helpers that operate on the map via setApps --------------------------

  const mount = useCallback((packageName: string, bundleUri: string, injectedJS: string) => {
    setApps((prev) => {
      const next = new Map(prev)
      next.set(packageName, {
        packageName,
        source: {uri: bundleUri},
        injectedJS,
        isForeground: false,
      })
      return next
    })
  }, [])

  const mountDev = useCallback((packageName: string, devUrl: string, injectedJS: string) => {
    setApps((prev) => {
      const next = new Map(prev)
      next.set(packageName, {
        packageName,
        source: {uri: devUrl},
        injectedJS,
        isForeground: false,
      })
      return next
    })
  }, [])

  const unmount = useCallback((packageName: string) => {
    setApps((prev) => {
      const next = new Map(prev)
      next.delete(packageName)
      return next
    })
    webViewRefs.current.delete(packageName)
    miniComms.setWebViewMessageHandler(packageName, undefined)
  }, [])

  const setForeground = useCallback((packageName: string) => {
    setApps((prev) => {
      const next = new Map(prev)
      const entry = next.get(packageName)
      if (entry) {
        next.set(packageName, {...entry, isForeground: true})
      }
      return next
    })
  }, [])

  const setBackground = useCallback((packageName: string) => {
    setApps((prev) => {
      const next = new Map(prev)
      const entry = next.get(packageName)
      if (entry) {
        next.set(packageName, {...entry, isForeground: false})
      }
      return next
    })
  }, [])

  const isRunning = useCallback(
    (packageName: string) => {
      return apps.has(packageName)
    },
    [apps],
  )

  // -- wire up the module-level singleton on mount --------------------------

  useEffect(() => {
    miniappHost.mount = mount
    miniappHost.mountDev = mountDev
    miniappHost.unmount = unmount
    miniappHost.setForeground = setForeground
    miniappHost.setBackground = setBackground
    miniappHost.isRunning = isRunning

    return () => {
      // Restore stubs on unmount so callers get a clear warning.
      miniappHost.mount = () => console.warn('MiniappHost: mount() called after unmount')
      miniappHost.mountDev = () => console.warn('MiniappHost: mountDev() called after unmount')
      miniappHost.unmount = () => console.warn('MiniappHost: unmount() called after unmount')
      miniappHost.setForeground = () => console.warn('MiniappHost: setForeground() called after unmount')
      miniappHost.setBackground = () => console.warn('MiniappHost: setBackground() called after unmount')
      miniappHost.isRunning = () => false
    }
  }, [mount, mountDev, unmount, setForeground, setBackground, isRunning])

  // -- WebView event handlers -----------------------------------------------

  const handleMessage = useCallback((packageName: string, event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data
    localMiniappRuntime.handleRawMessage(packageName, data)
  }, [])

  /**
   * Send a beforeevict envelope to the miniapp and wait up to 500ms for it to
   * flush state to session.storage. Best-effort — if the WebView is already
   * dead the inject will fail silently and we proceed to unmount.
   */
  const sendBeforeEvict = useCallback(
    async (packageName: string): Promise<void> => {
      const ref = webViewRefs.current.get(packageName)
      if (!ref) return
      try {
        const envelope = JSON.stringify({
          payload: {type: 'miniapp_before_evict'},
        })
        ref.injectJavaScript(
          `window.dispatchEvent(new MessageEvent('message', {data: ${JSON.stringify(envelope)}})); true;`,
        )
        // Give the miniapp up to BEFORE_EVICT_TIMEOUT_MS to persist state
        await new Promise((resolve) => setTimeout(resolve, BEFORE_EVICT_TIMEOUT_MS))
      } catch {
        // WebView may already be dead — proceed to unmount
      }
    },
    [],
  )

  const handleTerminate = useCallback(
    async (packageName: string) => {
      if (__DEV__) {
        Alert.alert(
          'Miniapp Terminated',
          `"${packageName}" was killed by the OS (out of memory). It has been unregistered.`,
        )
      }
      // beforeevict is best-effort — the JS context may already be gone on terminate
      await sendBeforeEvict(packageName)
      unmount(packageName)
    },
    [unmount, sendBeforeEvict],
  )

  const handleError = useCallback(
    async (packageName: string) => {
      if (__DEV__) {
        Alert.alert('Miniapp Error', `"${packageName}" encountered a fatal error and has been unregistered.`)
      }
      await sendBeforeEvict(packageName)
      unmount(packageName)
    },
    [unmount, sendBeforeEvict],
  )

  // Register MiniComms handlers whenever the app map changes so messages can
  // be sent back to each running WebView.
  useEffect(() => {
    for (const [packageName] of apps) {
      const ref = webViewRefs.current.get(packageName)
      if (ref) {
        miniComms.setWebViewMessageHandler(packageName, (message: string) => {
          ref.injectJavaScript(`window.receiveNativeMessage(${message}); true;`)
        })
      }
    }
  }, [apps])

  // -- render ---------------------------------------------------------------

  const entries = Array.from(apps.values())

  return (
    <View style={styles.container} pointerEvents="box-none">
      {entries.map((app) => {
        const isFg = app.isForeground

        return (
          <View key={app.packageName} style={isFg ? styles.foreground : styles.background} pointerEvents={isFg ? 'auto' : 'none'}>
            <WebView
              ref={(ref) => {
                if (ref) {
                  webViewRefs.current.set(app.packageName, ref)
                }
              }}
              source={app.source}
              originWhitelist={['*']}
              allowFileAccess={true}
              allowFileAccessFromFileURLs={true}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              injectedJavaScriptBeforeContentLoaded={app.injectedJS}
              onMessage={(e) => handleMessage(app.packageName, e)}
              onContentProcessDidTerminate={() => handleTerminate(app.packageName)}
              onError={() => handleError(app.packageName)}
              style={styles.webview}
            />
          </View>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  foreground: {
    flex: 1,
    ...StyleSheet.absoluteFillObject,
  },
  background: {
    position: 'absolute',
    left: -10000,
    top: -10000,
    width: 1,
    height: 1,
    opacity: 0,
  },
  webview: {
    flex: 1,
  },
})
