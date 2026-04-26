// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Shell} from "../Shell"

export default function EventsPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [lastButton, setLastButton] = useState<string>("(none)")
  const [lastTouch, setLastTouch] = useState<Record<string, unknown> | null>(null)
  const [headPos, setHeadPos] = useState<string>("(unknown)")
  const [glassesBattery, setGlassesBattery] = useState<string>("—")
  const [phoneBattery, setPhoneBattery] = useState<string>("—")
  const [connection, setConnection] = useState<Record<string, unknown> | null>(null)
  const [vad, setVad] = useState<boolean>(false)
  const [transcript, setTranscript] = useState<string>("")
  const [location, setLocation] = useState<Record<string, unknown> | null>(null)
  const [lastNotification, setLastNotification] = useState<Record<string, unknown> | null>(null)
  const [lastCalendar, setLastCalendar] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    const unsubs = [
      session.input.onButtonPress((d) => setLastButton(`${d.buttonId} (${d.pressType}) — ${new Date().toLocaleTimeString()}`)),
      session.input.onTouch((d) =>
        setLastTouch({...(d as unknown as Record<string, unknown>), timestamp: new Date().toLocaleTimeString()}),
      ),
      session.imu.onHeadPosition((d) => setHeadPos(`${d.position ?? "?"}`)),
      session.glasses.onBattery((d) => setGlassesBattery(`${d.level}%${d.charging ? " ⚡" : ""}`)),
      session.phone.onBattery((d) => setPhoneBattery(`${d.level}%${d.charging ? " ⚡" : ""}`)),
      session.glasses.onConnection((d) => setConnection(d as unknown as Record<string, unknown>)),
      session.mic.onVoiceActivity((d) => setVad(!!d.status)),
      session.transcription.on((d) => setTranscript(d.text)),
      session.location.onUpdate((d) =>
        setLocation({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
      session.phone.notifications.on((d) =>
        setLastNotification({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
      session.phone.calendar.on((d) =>
        setLastCalendar({...(d as unknown as Record<string, unknown>), receivedAt: new Date().toLocaleTimeString()}),
      ),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [session])

  return (
    <Shell>
      <MiniappHeader title="Event Monitors" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Passive listeners. The values below update live as events fire from the host.
        </p>

        <Row emoji="🔘" label="Last button press" value={lastButton} />
        <TableRow emoji="👆" label="Last touch" data={lastTouch} />
        <Row emoji="↕️" label="Head position" value={headPos} />
        <Row emoji="🔋" label="Glasses battery" value={glassesBattery} />
        <Row emoji="📱" label="Phone battery" value={phoneBattery} />

        <TableRow emoji="🔌" label="Glasses connection" data={connection} />

        <Row emoji="🗣️" label="VAD (speaking)" value={vad ? "YES" : "no"} />
        <Row emoji="📝" label="Transcript" value={transcript || "(none)"} />
        <TableRow emoji="📍" label="Location" data={location} />
        <TableRow emoji="🔔" label="Last notification" data={lastNotification} />
        <TableRow emoji="📅" label="Last calendar event" data={lastCalendar} />
      </div>
    </Shell>
  )
}

function Row({emoji, label, value, mono}: {emoji: string; label: string; value: string; mono?: boolean}) {
  return (
    <div className="mb-2 rounded-xl border border-border bg-card p-3">
      <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="text-base">{emoji}</span>
        <span>{label}</span>
      </div>
      <div className={`truncate text-sm ${mono ? "font-mono text-[11px]" : ""}`}>{value}</div>
    </div>
  )
}

function TableRow({
  emoji,
  label,
  data,
}: {
  emoji: string
  label: string
  data: Record<string, unknown> | null
}) {
  const entries = data ? sortedEntries(data) : []
  return (
    <div className="mb-2 rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="text-base">{emoji}</span>
        <span>{label}</span>
      </div>
      {!data || entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">(none)</div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-[12px]">
            <tbody>
              {entries.map(([key, val], i) => (
                <tr key={key} className={i % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {key}
                  </td>
                  <td className="break-all px-3 py-1.5 font-mono text-[11px]">
                    {renderValue(val)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function sortedEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  // Put primitives (non-empty) first, then empty-ish, then nested — readable
  // scanning order in a table.
  const entries = Object.entries(obj)
  const weight = (v: unknown) => {
    if (v == null || v === "" || v === -1) return 2
    if (typeof v === "object") return 3
    return 1
  }
  return entries.sort((a, b) => {
    const d = weight(a[1]) - weight(b[1])
    if (d !== 0) return d
    return a[0].localeCompare(b[0])
  })
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return v === -1 ? "—" : String(v)
  if (typeof v === "string") return v === "" ? "—" : v
  return JSON.stringify(v)
}
