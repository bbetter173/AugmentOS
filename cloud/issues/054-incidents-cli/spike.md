# Spike: Incidents CLI

## Overview

**What this doc covers:** A full architecture report on the current incident system (how bug reports flow from user to storage), and a design for a CLI tool that lets engineers and coding agents browse incidents and fetch logs without the web console.
**Why this doc exists:** Today, investigating a bug report requires either the web console (manual, slow for agents) or a bash script that only fetches logs by ID. There's no way to list incidents, filter by severity, search feedback text, or view phone state from the command line. This makes agent-assisted debugging (like we did for issues 051 and 052) dependent on the user pasting logs manually.
**Who should read this:** Cloud engineers, anyone building tooling for incident triage, anyone setting up the CLI for the first time.

---

## Current Incident System Architecture

### Data flow: creation → collection → processing → storage → retrieval

```
USER (mobile app) files bug report
  │
  ├─ POST /api/incidents → R2: skeleton JSON + MongoDB: record (status: processing)
  │                           │
  │                           └─ queueIncidentProcessing() [fire-and-forget async]
  │                                 │
  │                                 ├─ 1. Query BetterStack (cloud logs, 10min window)
  │                                 ├─ 2. Append cloud logs → R2
  │                                 ├─ 3. REQUEST_TELEMETRY → WebSocket → miniapps
  │                                 ├─ 4. Read full incident from R2
  │                                 ├─ 5. LLM generates BugSummary (title, description, severity)
  │                                 ├─ 6. Slack notification (fire-and-forget)
  │                                 └─ 7. MongoDB: status → complete/partial/failed
  │
  ├─ POST /api/incidents/:id/logs → R2: append phoneLogs
  ├─ POST /api/incidents/:id/logs (source: glasses) → R2: append glassesLogs
  ├─ POST /api/incidents/:id/logs (source: glasses_firmware) → R2: append glassesFirmwareLogs
  ├─ POST /api/incidents/:id/attachments → R2: store file + append metadata
  │
  └─ [Miniapps receive REQUEST_TELEMETRY via WebSocket]
       └─ POST /api/incidents/:id/logs (with uploadToken) → R2: append appTelemetryLogs[pkg]

RETRIEVAL:
  ├─ Console Admin:  GET /api/console/admin/incidents/*  (humans, web UI)
  ├─ Agent API:      GET /api/agent/incidents/*           (coding agents)
  └─ CLI:            scripts/fetch-incident-logs.sh       (bash wrapper)
```

### Storage: two layers

**MongoDB (`Incident` collection)** — metadata only:

| Field            | Type   | Notes                                            |
| ---------------- | ------ | ------------------------------------------------ |
| `incidentId`     | string | UUID v4, unique index                            |
| `userId`         | string | User email, compound index with createdAt        |
| `status`         | enum   | `processing` / `complete` / `partial` / `failed` |
| `summary`        | string | LLM-generated title (optional)                   |
| `linearIssueId`  | string | Disabled, always empty                           |
| `linearIssueUrl` | string | Disabled, always empty                           |
| `errorMessage`   | string | Processing failure details                       |
| `createdAt`      | Date   | Auto-managed                                     |
| `updatedAt`      | Date   | Auto-managed                                     |

**Cloudflare R2 (`mentra-incidents` bucket)** — actual log payloads:

Path: `incidents/{incidentId}.json`

```typescript
interface IncidentLogs {
  incidentId: string
  createdAt: string
  feedback: Record<string, unknown> // user's bug report text + system info
  phoneState: Record<string, unknown> // glasses, core, settings snapshots
  phoneLogs: LogEntry[] // mobile app console logs
  cloudLogs: LogEntry[] // BetterStack cloud logs (10min window)
  glassesLogs: LogEntry[] // ASG client logs
  glassesFirmwareLogs: LogEntry[] // BES chip logs
  appTelemetryLogs: Record<string, LogEntry[]> // miniapp logs keyed by packageName
  attachments?: AttachmentMetadata[] // screenshot references
}

interface LogEntry {
  timestamp: number | string
  level: string
  message: string
  source?: string
  metadata?: Record<string, unknown>
}
```

Attachments stored separately: `incidents/{incidentId}/attachments/{timestamp}-{filename}`

R2 operations use per-incident in-memory locks (promise queue) to prevent race conditions from concurrent appends.

### APIs: three access surfaces

**Client API** (`/api/incidents`) — mobile app, auth: Bearer coreToken (JWT)

| Method | Path                             | Purpose                                   |
| ------ | -------------------------------- | ----------------------------------------- |
| POST   | `/api/incidents`                 | Create incident                           |
| POST   | `/api/incidents/:id/logs`        | Upload phone/glasses/firmware/app logs    |
| POST   | `/api/incidents/:id/attachments` | Upload screenshots (max 5, max 10MB each) |

**Console Admin API** (`/api/console/admin/incidents`) — web UI, auth: console session + isMentraAdmin

| Method | Path                         | Purpose                                  |
| ------ | ---------------------------- | ---------------------------------------- |
| GET    | `/`                          | List incidents (paginated)               |
| GET    | `/:id`                       | Get incident metadata                    |
| GET    | `/:id/logs`                  | Get full logs from R2                    |
| GET    | `/:id/attachments/:filename` | Proxy attachment image with Content-Type |

**Agent API** (`/api/agent/incidents`) — coding agents, auth: `X-Agent-Key` header

| Method | Path        | Purpose                            |
| ------ | ----------- | ---------------------------------- |
| GET    | `/`         | List incidents (limit, offset)     |
| GET    | `/:id`      | Get incident metadata from MongoDB |
| GET    | `/:id/logs` | Get full logs from R2              |

The agent API is what the CLI will use. It's missing: severity/status filtering, text search, and attachment access.

### Processing pipeline

`cloud/packages/cloud/src/services/incidents/incident-processor.service.ts`

Runs as a fire-and-forget async call (no job queue). Steps:

1. Fetch cloud logs from BetterStack — SQL query filtering by userId, 10-minute window, max 1000 entries
2. Append cloud logs to R2
3. Send `REQUEST_TELEMETRY` via WebSocket to all connected miniapps (5-minute upload token)
4. Read full incident back from R2
5. LLM summary via `generateBugSummary()` — temperature 0.3, max 500 tokens, produces title + description + affected components + severity. Falls back to raw user text on failure.
6. Slack notification to `#feedback` channel (webhook) — severity color-coded, includes "View Logs" button linking to console
7. Update MongoDB: `status → complete/partial/failed`, save `summary`

Linear ticket creation: fully built but disabled (commented out). Email notification: also disabled. Only Slack is active.

### Notable gaps

1. **No job queue** — if the server restarts during processing, the incident stays `processing` forever with no retry
2. **No log size limits** on phone/glasses uploads — only attachments are bounded (5 files, 10MB)
3. **App telemetry requires WebSocket** — if a miniapp is disconnected at report time, its telemetry isn't collected (upload token expires in 5 minutes)
4. **R2 locks are in-memory** — lost on restart, don't work across pods
5. **Agent API has no filtering** — can only list with limit/offset, no severity, status, or text search

---

## CLI Design

### Location

New package at `cloud/packages/incidents/`. Separate from the cloud server — it's a client tool, not a server component. Has its own `package.json` with minimal dependencies (just an HTTP client and a CLI arg parser, if any).

### Auth

Reads `MENTRA_AGENT_API_KEY` from environment. The key should live in `cloud/.env` (gitignored). The CLI fails with a clear message if the key is missing. The key is never logged or included in output.

The API host defaults to `https://api.mentra.glass` but can be overridden via `MENTRA_API_HOST` env var (for testing against dev/staging).

### Commands

```
bun run cloud/packages/incidents/src/cli.ts list [options]
bun run cloud/packages/incidents/src/cli.ts get <incidentId>
bun run cloud/packages/incidents/src/cli.ts logs <incidentId> [options]
```

**`list`** — list recent incidents

```
Options:
  --limit <n>         Number of results (default: 20, max: 500)
  --offset <n>        Pagination offset (default: 0)
  --status <status>   Filter by status (processing/complete/partial/failed)
  --severity <n>      Filter by severity rating (1-5) [requires API enhancement]
  --json              Output raw JSON instead of formatted table
```

Output: table with columns `ID (short) | Status | Severity | Summary | User | Created`

**`get`** — show incident details

```
Options:
  --json              Output raw JSON
```

Output: formatted display of feedback text, system info, phone state snapshot, LLM summary, severity, running apps, and timestamps.

**`logs`** — fetch and display logs

```
Options:
  --type <type>       Log type: phone, cloud, glasses, firmware, apps, all (default: all)
  --app <package>     Filter app telemetry by package name
  --level <level>     Filter by log level: error, warn, info, debug
  --grep <pattern>    Search log messages by regex
  --limit <n>         Max log entries to display (default: 200)
  --json              Output raw JSON
```

Output: formatted log entries, color-coded by level (red=error, yellow=warn, white=info, gray=debug). Each line: `[timestamp] [level] [source] message`.

### API enhancements needed

The current agent API (`GET /api/agent/incidents`) only supports `limit` and `offset`. For the CLI to be useful, we should add:

| Parameter  | Purpose                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `status`   | Filter by processing status                                                                                |
| `severity` | Filter by feedback severity rating (stored in R2 feedback, not MongoDB — needs a MongoDB field or R2 scan) |
| `search`   | Text search across summary field                                                                           |
| `userId`   | Filter by user (useful for "show me this user's history")                                                  |
| `since`    | Only incidents after this ISO date                                                                         |

Severity is the tricky one — it's in the R2 feedback JSON, not in the MongoDB model. Options:

1. Add `severity` field to the MongoDB `Incident` model (backfill existing records)
2. Filter client-side in the CLI (works but wasteful for large datasets)

Option 1 is cleaner. The severity is available at creation time from `feedback.severityRating`.

### Package structure

```
cloud/packages/incidents/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts           # Entry point, arg parsing, command routing
│   ├── client.ts        # HTTP client wrapping the agent API
│   ├── commands/
│   │   ├── list.ts      # list command
│   │   ├── get.ts       # get command
│   │   └── logs.ts      # logs command
│   └── format.ts        # Output formatting (table, colors, log lines)
└── README.md
```

### Running it

```bash
# From repo root
cd cloud/packages/incidents
bun run src/cli.ts list --limit 10

# Or with a package.json script alias
bun run incidents list --limit 10

# Or from the cloud workspace root
bun run --filter @mentra/incidents cli list --limit 10
```

---

## Next Steps

1. Write `spec.md` with exact API contract changes (add severity to MongoDB, add query params to agent API)
2. Write `design.md` with the implementation plan (file-by-file changes)
3. Build the CLI package
4. Add `MENTRA_AGENT_API_KEY` to `cloud/.env.example` with a placeholder value
5. Test against prod agent API with real incident data
