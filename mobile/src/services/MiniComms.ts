/**
 * MiniComms — WebView message handler registry.
 *
 * Holds per-packageName send functions so that any service (MiniappHost,
 * webview.tsx) can inject JS into a specific WebView. That's it.
 *
 * Local miniapp message routing goes through LocalMiniappRuntime directly
 * (MiniappHost calls localMiniappRuntime.handleRawMessage). MiniComms is
 * not in that path.
 */

class MiniComms {
  private static instance: MiniComms | null = null
  private messageHandlers: Record<string, (stringified: string) => void> = {}

  private constructor() {}

  public static getInstance(): MiniComms {
    if (!MiniComms.instance) {
      MiniComms.instance = new MiniComms()
    }
    return MiniComms.instance
  }

  public cleanup() {
    this.messageHandlers = {}
    MiniComms.instance = null
  }

  public setWebViewMessageHandler(packageName: string, handler?: (stringified: string) => void) {
    if (handler) {
      this.messageHandlers[packageName] = handler
    } else {
      delete this.messageHandlers[packageName]
    }
  }

  public sendToMiniApp(packageName: string, message: object) {
    const handler = this.messageHandlers[packageName]
    if (!handler) return
    try {
      handler(JSON.stringify(message))
    } catch (error) {
      console.error(`MINICOM: Error sending to ${packageName}:`, error)
    }
  }
}

const miniComms = MiniComms.getInstance()
export default miniComms
