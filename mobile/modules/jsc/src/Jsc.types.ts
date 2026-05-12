export type JscConsoleLevel = "log" | "warn" | "error"

export type JscForegroundMessageEvent = {
  contextId: string
  data: unknown
}

export type JscConsoleEvent = {
  contextId: string
  level: JscConsoleLevel
  args: unknown[]
}

export type JscErrorEvent = {
  contextId: string
  message: string
  stack?: string
}

export type JscModuleEvents = {
  foreground_message: (event: JscForegroundMessageEvent) => void
  jsc_console: (event: JscConsoleEvent) => void
  jsc_error: (event: JscErrorEvent) => void
}
