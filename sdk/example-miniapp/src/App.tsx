import {useEffect, useRef, useState} from "react"
import {
  useCapabilities,
  useConnected,
  useSafeArea,
  useSession,
  useVisibility,
} from "@mentra/miniapp/react"
import type {ButtonPressData, TranscriptionData} from "@mentra/miniapp"

import {Badge} from "./ui/badge"
import {Button} from "./ui/button"
import {Card, CardContent, CardHeader, CardTitle} from "./ui/card"
import {Label} from "./ui/label"
import {Switch} from "./ui/switch"

export default function App() {
  const session = useSession()
  const {insets, capsuleMenu} = useSafeArea()
  const connected = useConnected()
  const caps = useCapabilities()
  const visibility = useVisibility()

  const [liveTranscript, setLiveTranscript] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [mirrorToGlasses, setMirrorToGlasses] = useState(true)
  const [lastButton, setLastButton] = useState("")
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [takingPhoto, setTakingPhoto] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll transcript history
  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: "smooth"})
  }, [history])

  // Subscribe to live transcription + button presses
  useEffect(() => {
    const unsubs = [
      session.events.onTranscription((data: TranscriptionData) => {
        setLiveTranscript(data.text)
        if (mirrorToGlasses) {
          session.layouts.showTextWall(data.text)
        }
        if (data.isFinal && data.text.trim()) {
          setHistory((prev) => [...prev, data.text.trim()])
          setLiveTranscript("")
        }
      }),
      session.events.onButtonPress((data: ButtonPressData) => {
        setLastButton(`${data.buttonId} (${data.pressType})`)
      }),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session, mirrorToGlasses])

  // Capabilities helpers
  const hasCamera = !!(caps && (caps as Record<string, unknown>).hasCamera)
  const hasMic = !!(caps && (caps as Record<string, unknown>).hasMicrophone)
  const hasDisplay = !!(caps && (caps as Record<string, unknown>).hasDisplay)
  const hasSpeaker = !!(caps && (caps as Record<string, unknown>).hasSpeaker)
  const hasWifi = !!(caps && (caps as Record<string, unknown>).hasWifi)
  const modelName = (caps as Record<string, unknown>)?.modelName as string | undefined

  const takePhoto = async () => {
    setTakingPhoto(true)
    setPhotoUrl(null)
    try {
      const result = await session.camera.takePhoto({size: "medium"})
      setPhotoUrl(result.photoUrl)
      session.layouts.showReferenceCard("Photo taken", result.photoUrl)
    } catch (err: unknown) {
      const error = err as {code?: string; message?: string}
      console.log("Photo error:", error.code, error.message)
    } finally {
      setTakingPhoto(false)
    }
  }

  const clearHistory = () => {
    setHistory([])
    setLiveTranscript("")
    session.layouts.clearView()
  }

  const speakSummary = async () => {
    const last3 = history.slice(-3).join(". ")
    const phrase = last3
      ? `Here's what was said: ${last3}`
      : "Nothing to summarize yet. Say something first."
    try {
      await session.audio.speak(phrase)
    } catch {
      /* TTS error */
    }
  }

  // Reserve space on the right of the header so the host's floating capsule
  // menu doesn't overlap the title.
  const capsuleGutter = capsuleMenu ? capsuleMenu.width + 16 : 0

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      {/* Header */}
      <header
        className="flex items-center justify-between px-5 pt-4 pb-2"
        style={{paddingRight: Math.max(20, capsuleGutter)}}>
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-mentra-green shadow-[0_0_8px_var(--mentra-green-10)]" : "bg-destructive"}`}
          />
          <h1 className="text-lg font-semibold">Live Captions</h1>
        </div>
        <Badge variant="secondary" className="font-mono text-[11px]">
          {modelName || "no glasses"}
        </Badge>
      </header>

      {/* Capabilities bar */}
      <div className="flex flex-wrap gap-1.5 border-b border-border px-5 pb-3 pt-2">
        <Chip label="Camera" on={hasCamera} />
        <Chip label="Mic" on={hasMic} />
        <Chip label="Display" on={hasDisplay} />
        <Chip label="Speaker" on={hasSpeaker} />
        <Chip label="WiFi" on={hasWifi} />
      </div>

      {/* Photo section — only if glasses have a camera */}
      {hasCamera && (
        <div className="flex flex-col items-center gap-3 border-b border-border p-4">
          <Button onClick={takePhoto} disabled={takingPhoto} className="w-full max-w-sm" size="lg">
            {takingPhoto ? "Taking photo…" : "Take Photo"}
          </Button>
          {photoUrl && (
            <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border">
              <img src={photoUrl} alt="Captured" className="block h-auto w-full" />
            </div>
          )}
        </div>
      )}

      {/* Live transcript */}
      <Card className="mx-5 mt-3 gap-2 py-4">
        <CardHeader className="gap-0 px-4">
          <CardTitle className="text-[10px] font-bold tracking-[0.15em] text-mentra-green">
            {hasMic ? "LISTENING" : "NO MICROPHONE"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <p className="m-0 text-xl font-light leading-snug">
            {liveTranscript || <span className="text-muted-foreground">Waiting for speech…</span>}
          </p>
        </CardContent>
      </Card>

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2">
          <Switch id="mirror" checked={mirrorToGlasses} onCheckedChange={setMirrorToGlasses} />
          <Label htmlFor="mirror" className="text-sm text-muted-foreground">
            Mirror to glasses
          </Label>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={speakSummary}>
            Speak Summary
          </Button>
          <Button variant="destructive" size="sm" onClick={clearHistory}>
            Clear
          </Button>
        </div>
      </div>

      {/* Transcript history */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 pb-5">
        {history.length === 0 ? (
          <p className="mt-10 text-center text-sm leading-relaxed text-muted-foreground">
            Transcribed sentences appear here as you speak.
            {mirrorToGlasses && " They also show on your glasses in real time."}
          </p>
        ) : (
          history.map((line, i) => (
            <div key={i} className="flex gap-3 border-b border-border/50 py-2.5 text-sm leading-relaxed">
              <span className="min-w-5 pt-0.5 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              <span>{line}</span>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <footer className="flex justify-between border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
        {lastButton && <span>Button: {lastButton}</span>}
        <span>
          {history.length} sentence{history.length !== 1 ? "s" : ""}
        </span>
        <span>{visibility}</span>
      </footer>
    </div>
  )
}

function Chip({label, on}: {label: string; on: boolean}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium ${
        on
          ? "border-mentra-green/40 bg-mentra-green/15 text-mentra-green"
          : "border-border bg-muted text-muted-foreground"
      }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-mentra-green" : "bg-muted-foreground/50"}`} />
      {label}
    </span>
  )
}
