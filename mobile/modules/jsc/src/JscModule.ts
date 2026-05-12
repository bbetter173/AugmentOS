import {NativeModule, requireNativeModule} from "expo"

import {JscConsoleEvent, JscErrorEvent, JscForegroundMessageEvent, JscModuleEvents} from "./Jsc.types"

type ForegroundListener = (event: JscForegroundMessageEvent) => void
type ConsoleListener = (event: JscConsoleEvent) => void
type ErrorListener = (event: JscErrorEvent) => void

declare class JscModule extends NativeModule<JscModuleEvents> {
  /**
   * Create a new isolated JSContext. Each context gets its own JSVirtualMachine
   * so heaps are not shared. Throws if a context with the same id already exists.
   */
  createContext(id: string): Promise<void>

  /**
   * Tear down a context: cancel timers, drop refs, release the JSContext + VM.
   * No-op if id is unknown.
   */
  destroyContext(id: string): Promise<void>

  /**
   * Evaluate a script in the named context. Returns the script's last expression
   * value, JSON-serialized to a JS-side value (objects/arrays/primitives only).
   * Throws if the context is unknown or the script throws.
   */
  evaluate(id: string, script: string): Promise<unknown>

  /** Return the ids of all live contexts. */
  listContexts(): string[]

  // Listener helpers — installed at runtime below.
  onForegroundMessage(callback: ForegroundListener): () => void
  onConsole(callback: ConsoleListener): () => void
  onContextError(callback: ErrorListener): () => void
}

const Jsc = requireNativeModule<JscModule>("Jsc")

Jsc.onForegroundMessage = function (callback: ForegroundListener) {
  const subscription = this.addListener("foreground_message", callback)
  return () => subscription.remove()
}

Jsc.onConsole = function (callback: ConsoleListener) {
  const subscription = this.addListener("jsc_console", callback)
  return () => subscription.remove()
}

Jsc.onContextError = function (callback: ErrorListener) {
  const subscription = this.addListener("jsc_error", callback)
  return () => subscription.remove()
}

export default Jsc
