

import {Linking} from "react-native"
import Share from "react-native-share"
import * as Clipboard from "expo-clipboard"
import {File, Paths} from "expo-file-system"
import CoreModule from "core"

type MiniAppMessageType =
  | "core_fn"
  | "request_mic_audio"
  | "request_transcription"
  | "display_event"
  | "button_click"
  | "page_ready"
  | "custom_action"
  | "share"
  | "open_url"
  | "copy_clipboard"
  | "download"
  | "queue_display_event"

export interface MiniAppMessage {
  type: MiniAppMessageType
  payload?: any
  timestamp?: number
  requestId?: string
}

class MiniSockets {
  private static instance: MiniSockets | null = null
  private messageHandlers: Record<string, (stringified: string) => void> = {}

  private constructor() {
    this.socket = new WebSocket("ws://localhost:8080")
  }

  public static getInstance(): MiniSockets {
    if (!MiniSockets.instance) {
      MiniSockets.instance = new MiniSockets()
    }
    return MiniSockets.instance
  }

  public cleanup() {
    MiniSockets.instance = null
  }

}

const miniSockets = MiniSockets.getInstance()
export default miniSockets
