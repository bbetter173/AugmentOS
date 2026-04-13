/**
 * @fileoverview Auto-detect the right Transport based on environment.
 */

import {LocalSocketTransport, LocalSocketTransportOptions} from "./local-socket"
import {PostMessageTransport} from "./postmessage"
import {Transport} from "./types"

export interface CreateTransportOptions {
  /** Force a specific transport. Skip auto-detection. */
  transport?: Transport
  /** For LocalSocketTransport fallback — override the ws URL. */
  localSocketUrl?: string
}

/**
 * Return a Transport appropriate for the current environment.
 *
 * - Inside a MentraOS WebView (window.ReactNativeWebView defined): PostMessageTransport
 * - In an external browser with WebSocket available: LocalSocketTransport
 * - Otherwise: throws
 */
export function createTransport(options: CreateTransportOptions = {}): Transport {
  if (options.transport) return options.transport

  if (typeof window !== "undefined" && window.ReactNativeWebView) {
    return new PostMessageTransport()
  }

  if (typeof WebSocket !== "undefined") {
    const localSocketOptions: LocalSocketTransportOptions = {}
    if (options.localSocketUrl) localSocketOptions.url = options.localSocketUrl
    return new LocalSocketTransport(localSocketOptions)
  }

  throw new Error(
    "@mentra/miniapp: no suitable transport available. Not in a React Native WebView and no WebSocket global.",
  )
}
