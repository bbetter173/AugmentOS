// Sidecar dev server for `mentra-miniapp dev`. Runs on a separate port from the
// user's miniapp server (default `userPort + 1`). Hosts the `__mentra_dev`
// WebSocket multiplexed channel:
//
//   laptop → phone : {type: "reload"}                 (filesystem watcher fired)
//   phone  → laptop: {type: "log", level, args, ...}  (forwarded console calls)
//
// Plus a hello handshake (`{type: "hello", protocol: "mentra-dev/1"}` →
// `{type: "hello-ack"}`) so a phone connecting to the wrong sidecar (or an
// older one) can detect mismatch.
//
// Designed to coexist with whatever the user's `server.ts` is doing — we don't
// touch their code, we just listen on a separate port.

import {readdirSync, statSync, watch} from "fs"
import {join, relative} from "path"
import type {ServerWebSocket} from "bun"

export interface DevServerOptions {
  port: number
  /** Project root to watch for filesystem changes. Triggers reload broadcasts. */
  watchDir: string
  /** Suppress info console.log output. Default false. */
  silent?: boolean
}

interface ClientWsData {
  packageName: string | null
  remoteAddress: string
}

const PROTOCOL_VERSION = "mentra-dev/1"
const RELOAD_DEBOUNCE_MS = 100

/** Inbound message from the phone. */
type Inbound =
  | {type: "hello"; protocol: string}
  | {type: "log"; level: string; args: unknown[]; packageName: string; timestamp: number}

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
}

function colorForLevel(level: string): string {
  switch (level) {
    case "error":
      return COLOR.red
    case "warn":
      return COLOR.yellow
    case "info":
    case "debug":
      return COLOR.dim
    default:
      return COLOR.cyan
  }
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a !== null && typeof a === "object" && (a as Record<string, unknown>).__error === true) {
        const err = a as {message?: string; stack?: string}
        return err.stack || err.message || String(a)
      }
      if (typeof a === "string") return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(" ")
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

/**
 * Start the sidecar. Returns a handle with `stop()` so dev.ts can clean up on
 * SIGINT.
 */
export function startDevSidecar(options: DevServerOptions): {stop: () => void; port: number} {
  const sockets = new Set<ServerWebSocket<ClientWsData>>()
  const log = options.silent ? () => {} : (...args: unknown[]) => console.log(...args)

  const server = Bun.serve<ClientWsData, undefined>({
    hostname: "0.0.0.0",
    port: options.port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/__mentra_dev/health") {
        return new Response(JSON.stringify({ok: true, protocol: PROTOCOL_VERSION}), {
          headers: {"content-type": "application/json"},
        })
      }
      if (url.pathname === "/__mentra_dev/files") {
        // List of project files the phone should snapshot to its bundle cache.
        // Walked from the watch dir, BFS-bounded depth + count to keep things
        // sane even on weird projects.
        const files = listProjectFiles(options.watchDir)
        return new Response(JSON.stringify({files}), {
          headers: {"content-type": "application/json"},
        })
      }
      if (url.pathname === "/__mentra_dev") {
        const upgraded = srv.upgrade(req, {
          data: {packageName: null, remoteAddress: srv.requestIP(req)?.address ?? "unknown"},
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade required", {status: 400})
      }
      return new Response("Not found", {status: 404})
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        log(
          `${COLOR.dim}[__mentra_dev]${COLOR.reset} client connected (${ws.data.remoteAddress})`,
        )
      },
      message(ws, message) {
        let parsed: Inbound
        try {
          parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as Inbound
        } catch {
          return
        }
        switch (parsed.type) {
          case "hello": {
            // Echo back so the phone confirms the right server.
            ws.send(JSON.stringify({type: "hello-ack", protocol: PROTOCOL_VERSION}))
            return
          }
          case "log": {
            const color = colorForLevel(parsed.level)
            const tag = `[${parsed.packageName ?? "?"}] ${parsed.level}`
            const body = formatLogArgs(parsed.args ?? [])
            log(
              `${COLOR.dim}${fmtTime(parsed.timestamp ?? Date.now())}${COLOR.reset} ${color}${tag}${COLOR.reset} ${body}`,
            )
            return
          }
        }
      },
      close(ws) {
        sockets.delete(ws)
        log(`${COLOR.dim}[__mentra_dev]${COLOR.reset} client disconnected`)
      },
    },
  })

  // Filesystem watcher → broadcast reload.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(options.watchDir, {recursive: true}, (_event, filename) => {
    if (!filename) return
    // Skip noisy directories — most projects don't want to reload on
    // node_modules or dist churn.
    if (filename.startsWith("node_modules/") || filename.includes("/node_modules/")) return
    if (filename.startsWith(".git/") || filename.includes("/.git/")) return
    if (filename.startsWith("dist/")) return
    if (filename.startsWith(".next/")) return

    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      const msg = JSON.stringify({type: "reload"})
      let count = 0
      for (const s of sockets) {
        try {
          s.send(msg)
          count++
        } catch {
          /* ignore */
        }
      }
      if (count > 0) {
        log(`${COLOR.cyan}[__mentra_dev]${COLOR.reset} reload → ${count} client(s) (${filename})`)
      }
    }, RELOAD_DEBOUNCE_MS)
  })

  log(`${COLOR.dim}[__mentra_dev]${COLOR.reset} sidecar listening on :${options.port}`)

  return {
    port: options.port,
    stop() {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
      if (reloadTimer) clearTimeout(reloadTimer)
      for (const s of sockets) {
        try {
          s.close()
        } catch {
          /* ignore */
        }
      }
      sockets.clear()
      server.stop(true)
    },
  }
}

/**
 * Walk the dev project's directory tree and return a list of relative file
 * paths suitable for the phone-side bundle snapshotter to fetch.
 *
 * BFS-bounded:
 *   - max depth 5 (most miniapp trees are 2-3 levels deep)
 *   - max files 500 (truncates with a warning beyond that)
 *
 * Excludes: node_modules, dist, .git, .next, .env*, hidden files starting
 * with ".", and any path containing __mentra_dev (the sidecar's own paths).
 */
function listProjectFiles(rootDir: string): string[] {
  const MAX_DEPTH = 5
  const MAX_FILES = 500
  const EXCLUDED_DIRS = new Set([
    "node_modules",
    "dist",
    ".git",
    ".next",
    "build",
    ".cache",
    ".turbo",
  ])

  const out: string[] = []
  type Frame = {dir: string; depth: number}
  const queue: Frame[] = [{dir: rootDir, depth: 0}]

  while (queue.length > 0 && out.length < MAX_FILES) {
    const {dir, depth} = queue.shift()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      // Skip hidden + excluded directories, .env files, and the sidecar's own paths.
      if (entry.startsWith(".env")) continue
      if (entry.startsWith(".") && entry !== ".") continue
      if (EXCLUDED_DIRS.has(entry)) continue
      if (entry === "__mentra_dev") continue

      const abs = join(dir, entry)
      let stat
      try {
        stat = statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH) queue.push({dir: abs, depth: depth + 1})
      } else if (stat.isFile()) {
        // Return as a leading-slash relative path for direct concatenation
        // with the dev server's URL on the phone side.
        const rel = relative(rootDir, abs).split("\\").join("/")
        out.push(`/${rel}`)
        if (out.length >= MAX_FILES) {
          console.warn(
            `[__mentra_dev] file list truncated at ${MAX_FILES} entries — bundle cache may be incomplete`,
          )
          return out
        }
      }
    }
  }
  return out
}
