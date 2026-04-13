import {useEffect, useState, useRef} from "react"
import {useSession} from "@mentra/miniapp/react"
import type {TranscriptionData, ButtonPressData, GlassesCapabilities} from "@mentra/miniapp"

export default function App() {
  const session = useSession()

  const [liveTranscript, setLiveTranscript] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [mirrorToGlasses, setMirrorToGlasses] = useState(true)
  const [lastButton, setLastButton] = useState("")
  const [connected, setConnected] = useState(false)
  const [caps, setCaps] = useState<GlassesCapabilities | null>(session.capabilities)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [takingPhoto, setTakingPhoto] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll transcript history
  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: "smooth"})
  }, [history])

  // Track connection + capabilities
  useEffect(() => {
    if (session.ready) {
      setConnected(true)
      setCaps(session.capabilities)
    }
    const unsubs = [
      session.on("disconnect", () => setConnected(false)),
      session.onCapabilitiesChange((c) => setCaps(c)),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  // Subscribe to live transcription + button presses
  useEffect(() => {
    const unsubs = [
      session.events.onTranscription("en-US", (data: TranscriptionData) => {
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
    if (!last3) return
    try {
      await session.audio.speak(`Here's what was said: ${last3}`)
    } catch { /* TTS error */ }
  }

  return (
    <div style={styles.app}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={dot(connected)} />
          <h1 style={styles.title}>Live Captions</h1>
        </div>
        <span style={styles.badge}>{modelName || "no glasses"}</span>
      </header>

      {/* Capabilities bar */}
      <div style={styles.capsBar}>
        <Chip label="Camera" on={hasCamera} />
        <Chip label="Mic" on={hasMic} />
        <Chip label="Display" on={hasDisplay} />
        <Chip label="Speaker" on={hasSpeaker} />
        <Chip label="WiFi" on={hasWifi} />
      </div>

      {/* Photo section — only if glasses have a camera */}
      {hasCamera && (
        <div style={styles.photoSection}>
          <button
            style={{...styles.btn, ...styles.btnPhoto, ...(takingPhoto ? styles.btnDisabled : {})}}
            onClick={takePhoto}
            disabled={takingPhoto}
          >
            {takingPhoto ? "Taking photo..." : "Take Photo"}
          </button>
          {photoUrl && (
            <div style={styles.photoFrame}>
              <img src={photoUrl} alt="Captured" style={styles.photo} />
            </div>
          )}
        </div>
      )}

      {/* Live transcript */}
      <div style={styles.liveBox}>
        <div style={styles.liveLabel}>
          {hasMic ? "LISTENING" : "NO MICROPHONE"}
        </div>
        <p style={styles.liveText}>
          {liveTranscript || <span style={{opacity: 0.3}}>Waiting for speech...</span>}
        </p>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={mirrorToGlasses}
            onChange={(e) => setMirrorToGlasses(e.target.checked)}
            style={styles.checkbox}
          />
          Mirror to glasses
        </label>
        <div style={styles.btnGroup}>
          <button style={styles.btn} onClick={speakSummary}>Speak Summary</button>
          <button style={{...styles.btn, ...styles.btnDanger}} onClick={clearHistory}>Clear</button>
        </div>
      </div>

      {/* Transcript history */}
      <div ref={scrollRef} style={styles.historyBox}>
        {history.length === 0 ? (
          <p style={styles.emptyState}>
            Transcribed sentences appear here as you speak.
            {mirrorToGlasses && " They also show on your glasses in real time."}
          </p>
        ) : (
          history.map((line, i) => (
            <div key={i} style={styles.historyLine}>
              <span style={styles.lineNum}>{i + 1}</span>
              <span>{line}</span>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <footer style={styles.footer}>
        {lastButton && <span>Button: {lastButton}</span>}
        <span>{history.length} sentence{history.length !== 1 ? "s" : ""}</span>
        <span>{session.visibility}</span>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chip component for capabilities
// ---------------------------------------------------------------------------

function Chip({label, on}: {label: string; on: boolean}) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "3px 10px",
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 500,
      background: on ? "#0a2a1a" : "#1a1a1a",
      color: on ? "#00ff88" : "#444",
      border: `1px solid ${on ? "#00ff8833" : "#222"}`,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%",
        background: on ? "#00ff88" : "#333",
      }} />
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const dot = (on: boolean): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: "50%",
  background: on ? "#00ff88" : "#ff4444",
  boxShadow: on ? "0 0 8px #00ff8866" : "none",
})

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#0d0d1a",
    color: "#e0e0e0",
    fontFamily: "-apple-system, system-ui, 'Segoe UI', sans-serif",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px 8px",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
    color: "#fff",
  },
  badge: {
    fontSize: 11,
    color: "#666",
    background: "#1a1a2e",
    padding: "4px 10px",
    borderRadius: 12,
    fontFamily: "monospace",
  },
  capsBar: {
    display: "flex",
    gap: 6,
    padding: "8px 20px 12px",
    flexWrap: "wrap",
    borderBottom: "1px solid #1a1a3a",
  },
  photoSection: {
    padding: "12px 20px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    borderBottom: "1px solid #1a1a3a",
  },
  photoFrame: {
    borderRadius: 12,
    overflow: "hidden",
    border: "1px solid #2a2a5a",
    maxWidth: 400,
    width: "100%",
  },
  photo: {
    width: "100%",
    height: "auto",
    display: "block",
  },
  btnPhoto: {
    background: "#1a2a3a",
    borderColor: "#2a4a6a",
    color: "#66aaff",
    width: "100%",
    maxWidth: 400,
    padding: "12px 20px",
    fontSize: 15,
    fontWeight: 600,
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  liveBox: {
    margin: "12px 20px",
    padding: 20,
    borderRadius: 12,
    background: "linear-gradient(135deg, #1a1a3a 0%, #0d1a2a 100%)",
    border: "1px solid #2a2a5a",
    minHeight: 80,
  },
  liveLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 2,
    color: "#00ff88",
    marginBottom: 8,
  },
  liveText: {
    fontSize: 20,
    lineHeight: 1.4,
    margin: 0,
    color: "#fff",
    fontWeight: 300,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 20px",
    marginBottom: 12,
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#aaa",
    cursor: "pointer",
  },
  checkbox: {
    accentColor: "#00ff88",
  },
  btnGroup: {
    display: "flex",
    gap: 8,
  },
  btn: {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 8,
    border: "1px solid #333",
    background: "#1a1a3a",
    color: "#ccc",
    cursor: "pointer",
  },
  btnDanger: {
    borderColor: "#442222",
    color: "#ff6666",
  },
  historyBox: {
    flex: 1,
    overflowY: "auto",
    padding: "0 20px 20px",
  },
  emptyState: {
    textAlign: "center",
    color: "#444",
    marginTop: 40,
    fontSize: 14,
    lineHeight: 1.6,
  },
  historyLine: {
    display: "flex",
    gap: 12,
    padding: "10px 0",
    borderBottom: "1px solid #1a1a2e",
    fontSize: 14,
    lineHeight: 1.5,
  },
  lineNum: {
    color: "#333",
    fontFamily: "monospace",
    fontSize: 11,
    minWidth: 20,
    paddingTop: 2,
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 20px",
    fontSize: 11,
    color: "#444",
    borderTop: "1px solid #1a1a2e",
  },
}
