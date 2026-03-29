#!/usr/bin/env bun
/**
 * bstack — BetterStack CLI for MentraCloud SRE
 *
 * A CLI tool that wraps BetterStack's SQL API with pre-built SRE queries.
 * Enables instant production diagnostics without constructing ClickHouse SQL by hand.
 *
 * Usage:
 *   bstack health                          # Quick health check across all regions
 *   bstack diagnostics --region us-central # Full diagnostics for a region
 *   bstack crash-timeline --region france  # What happened before the last crash
 *   bstack memory --region us-central      # Memory trend over time
 *   bstack gc --region us-central          # GC probe analysis
 *   bstack gaps --region us-central        # Event loop gap analysis
 *   bstack budget --region us-central      # Operation budget (CPU consumers)
 *   bstack slow-queries --region france    # MongoDB slow query analysis
 *   bstack cache --region us-central       # App cache status
 *   bstack incidents --limit 10            # Recent uptime incidents
 *   bstack sources                         # List all BetterStack sources
 *   bstack sql "SELECT ..."                # Raw SQL query
 *   bstack runbook pod-crash               # Open a runbook
 *
 * Environment:
 *   BETTERSTACK_USERNAME / BETTERSTACK_SQL_USERNAME  — ClickHouse HTTP API username
 *   BETTERSTACK_PASSWORD / BETTERSTACK_SQL_PASSWORD  — ClickHouse HTTP API password
 *   BETTERSTACK_API_TOKEN                            — Management API token (for uptime)
 *
 * See: cloud/issues/064-bstack-cli/spike.md
 * See: cloud/tools/bstack/inventory.md
 */

export {};

import {
  SQL_ENDPOINT,
  SQL_USERNAME,
  SQL_PASSWORD,
  API_TOKEN,
  UPTIME_API,
  LOG_SOURCES,
  COLLECTORS,
  UPTIME_MONITORS,
  DASHBOARDS,
  REGIONS,
  DIAGNOSTIC_FEATURES,
  validateSqlCredentials,
  validateApiToken,
  getLogsTable,
  getCollectorTable,
  getAllRegions,
} from "./config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function parseArgs(): { command: string; flags: Record<string, string>; positional: string[] } {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, ...val] = arg.slice(2).split("=");
      flags[key] = val.length > 0 ? val.join("=") : (args[++i] ?? "true");
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

function getFlag(flags: Record<string, string>, name: string, defaultVal: string): string {
  return flags[name] ?? defaultVal;
}

/**
 * Normalize a human-friendly duration string into ClickHouse INTERVAL syntax.
 * Accepts: "30m", "1h", "2d", "30 MINUTE", "1 HOUR", etc.
 * Returns: "30 MINUTE", "1 HOUR", "2 DAY", etc.
 */
function normalizeDuration(input: string): string {
  const match = input.match(/^(\d+)\s*(m|min|minute|h|hr|hour|d|day|s|sec|second)s?$/i);
  if (match) {
    const num = match[1];
    const unit = match[2].toLowerCase();
    if (unit.startsWith("m")) return `${num} MINUTE`;
    if (unit.startsWith("h")) return `${num} HOUR`;
    if (unit.startsWith("d")) return `${num} DAY`;
    if (unit.startsWith("s")) return `${num} SECOND`;
  }
  // Already in ClickHouse format (e.g. "30 MINUTE") or raw — pass through
  return input;
}

/**
 * Pick the correct BetterStack log source table for a region.
 * France and East Asia may still be on the legacy AugmentOS source.
 */
function getSourceForRegion(region: string): string {
  if (region === "france" || region === "east-asia") {
    // These regions may still send to the legacy source until redeployed
    // with the new BETTERSTACK_SOURCE_TOKEN. Check both — prefer prod.
    return getLogsTable("prod");
  }
  return getLogsTable("prod");
}

// ---------------------------------------------------------------------------
// SQL Query Engine
// ---------------------------------------------------------------------------

interface QueryResult {
  data: Record<string, any>[];
  rows: number;
  statistics?: { elapsed: number; rows_read: number; bytes_read: number };
}

async function runSql(sql: string): Promise<QueryResult> {
  validateSqlCredentials();

  const auth = Buffer.from(`${SQL_USERNAME}:${SQL_PASSWORD}`).toString("base64");
  const res = await fetch(SQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "plain/text",
      "Authorization": `Basic ${auth}`,
    },
    body: sql + " FORMAT JSON",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BetterStack SQL error (${res.status}): ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as any;
  return {
    data: json.data ?? [],
    rows: json.rows ?? 0,
    statistics: json.statistics,
  };
}

function printTable(data: Record<string, any>[], columns?: string[]): void {
  if (data.length === 0) {
    console.log("  (no data)");
    return;
  }

  const cols = columns ?? Object.keys(data[0]);
  const widths = cols.map((col) => {
    const maxData = data.reduce((max, row) => {
      const val = String(row[col] ?? "");
      return val.length > max ? val.length : max;
    }, 0);
    return Math.max(col.length, maxData, 4);
  });

  // Header
  console.log(cols.map((c, i) => pad(c, widths[i])).join(" │ "));
  console.log(widths.map((w) => "─".repeat(w)).join("─┼─"));

  // Rows
  for (const row of data) {
    console.log(cols.map((c, i) => pad(String(row[c] ?? ""), widths[i])).join(" │ "));
  }
}

// ---------------------------------------------------------------------------
// Uptime API
// ---------------------------------------------------------------------------

async function fetchUptime(path: string): Promise<any> {
  validateApiToken();
  const res = await fetch(`${UPTIME_API}${path}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Uptime API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// ── health ──────────────────────────────────────────────────────────────────

async function cmdHealth() {
  console.log("🏥 Health Check — All Regions\n");

  const results: Record<string, any>[] = [];

  for (const [regionId, region] of Object.entries(REGIONS)) {
    try {
      const res = await fetch(region.healthUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        results.push({
          region: regionId,
          status: `HTTP ${res.status}`,
          sessions: "?",
          uptime: "?",
          rss: "?",
          lag: "?",
        });
        continue;
      }
      const d = (await res.json()) as any;

      // The /health response has nested fields:
      //   sessions.userSessions, eventLoop.lagMs, uptimeSeconds, rssMB, heapUsedMB
      // Also support flat fields for backward compatibility.
      const sessions = d.sessions?.userSessions ?? d.activeSessions ?? "?";
      const uptime = d.uptimeSeconds ?? "?";
      const rss = d.rssMB ?? "?";
      const lag = d.eventLoop?.lagMs ?? d.eventLoopLagMs ?? "?";
      const heap = d.heapUsedMB ?? "?";

      results.push({
        region: regionId,
        status: d.status ?? "?",
        sessions,
        uptime: `${uptime}s`,
        rss: `${rss}MB`,
        heap: `${heap}MB`,
        lag: `${typeof lag === "number" ? lag.toFixed(1) : lag}ms`,
      });
    } catch (err: any) {
      results.push({
        region: regionId,
        status: "UNREACHABLE",
        sessions: "-",
        uptime: "-",
        rss: "-",
        heap: "-",
        lag: "-",
      });
    }
  }

  printTable(results);

  // Also check uptime monitors (don't exit if token is missing)
  if (!API_TOKEN) {
    console.log("\n  (Skipping uptime monitors — BETTERSTACK_API_TOKEN not set)");
    return;
  }
  try {
    const monitors = await fetchUptime("/monitors");
    console.log("\n📡 Uptime Monitors:\n");
    const monitorRows = monitors.data.map((m: any) => ({
      name: m.attributes.pronounceable_name,
      status: m.attributes.status === "up" ? "🟢 Up" : "🔴 Down",
      checked: m.attributes.last_checked_at?.slice(0, 19) ?? "?",
    }));
    printTable(monitorRows);
  } catch {
    console.log("\n  (Could not fetch uptime monitors)");
  }
}

// ── diagnostics ─────────────────────────────────────────────────────────────

async function cmdDiagnostics(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"));
  const source = getSourceForRegion(region);

  console.log(`🔍 Diagnostics — ${region} (last ${duration})\n`);

  // GC probes
  console.log("── GC Probes ──");
  const gc = await runSql(`
    SELECT
      round(avg(JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)')), 1) AS avg_gc_ms,
      max(JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)')) AS max_gc_ms,
      round(avg(JSONExtract(raw, 'freedMB', 'Nullable(Float64)')), 1) AS avg_freed_mb,
      round(avg(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')), 0) AS avg_rss_mb,
      round(avg(JSONExtract(raw, 'activeSessions', 'Nullable(Float64)')), 0) AS avg_sessions,
      count() AS probes
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'gc-probe'
  `);
  printTable(gc.data);

  // Event loop gaps
  console.log("\n── Event Loop Gaps ──");
  const gaps = await runSql(`
    SELECT count() AS gap_count,
      round(avg(JSONExtract(raw, 'gapMs', 'Nullable(Float64)')), 0) AS avg_gap_ms,
      max(JSONExtract(raw, 'gapMs', 'Nullable(Float64)')) AS max_gap_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'event-loop-gap'
  `);
  if (gaps.data[0]?.gap_count === 0 || gaps.data[0]?.gap_count === "0") {
    console.log("  ✅ No event loop gaps detected (event loop was never blocked >1s)");
  } else {
    printTable(gaps.data);
  }

  // MongoDB slow queries
  console.log("\n── MongoDB Slow Queries ──");
  const mongo = await runSql(`
    SELECT
      count() AS slow_queries,
      round(avg(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS avg_ms,
      max(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')) AS max_ms,
      round(sum(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS total_wall_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'slow-query'
  `);
  printTable(mongo.data);

  // Operation budget
  console.log("\n── Operation Budget (avg per 30s window) ──");
  const budget = await runSql(`
    SELECT
      round(avg(JSONExtract(raw, 'op_audioProcessing_ms', 'Nullable(Float64)')), 0) AS audio_ms,
      round(avg(JSONExtract(raw, 'op_glassesMessage_ms', 'Nullable(Float64)')), 0) AS glasses_ms,
      round(avg(JSONExtract(raw, 'op_appMessage_ms', 'Nullable(Float64)')), 0) AS app_msg_ms,
      round(avg(JSONExtract(raw, 'op_displayRendering_ms', 'Nullable(Float64)')), 0) AS display_ms,
      round(avg(JSONExtract(raw, 'opTotalMs', 'Nullable(Float64)')), 0) AS total_ms,
      round(avg(JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)')), 1) AS budget_pct,
      round(avg(JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)')), 0) AS mongo_blocking_ms,
      round(avg(JSONExtract(raw, 'totalConnections', 'Nullable(Float64)')), 0) AS connections,
      round(avg(JSONExtract(raw, 'activeSessions', 'Nullable(Float64)')), 0) AS sessions,
      round(avg(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')), 0) AS rss_mb
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
  `);
  printTable(budget.data);

  // App cache
  console.log("\n── App Cache ──");
  const cache = await runSql(`
    SELECT
      JSONExtract(raw, 'count', 'Nullable(Int32)') AS apps_cached,
      JSONExtract(raw, 'refreshMs', 'Nullable(Float64)') AS refresh_ms,
      JSONExtract(raw, 'refreshCount', 'Nullable(Int32)') AS refresh_count,
      dt
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'app-cache'
    ORDER BY dt DESC
    LIMIT 3
  `);
  printTable(cache.data);
}

// ── crash-timeline ──────────────────────────────────────────────────────────

async function cmdCrashTimeline(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "10 MINUTE"));
  const source = getSourceForRegion(region);

  console.log(`💥 Crash Timeline — ${region} (last ${duration})\n`);

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'feature', 'Nullable(String)') AS feature,
      substring(JSONExtract(raw, 'message', 'Nullable(String)'), 1, 80) AS message,
      JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)') AS gc_ms,
      JSONExtract(raw, 'gapMs', 'Nullable(Float64)') AS gap_ms,
      JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)') AS mongo_ms,
      JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)') AS budget_pct,
      JSONExtract(raw, 'rssMB', 'Nullable(Float64)') AS rss_mb,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions,
      JSONExtract(raw, 'durationMs', 'Nullable(Float64)') AS duration_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') IN (
        'gc-probe', 'event-loop-gap', 'system-vitals', 'slow-query',
        'app-cache', 'gc-after-disconnect', 'health-timing', 'soniox-timing'
      )
    ORDER BY dt DESC
    LIMIT 100
  `);

  printTable(result.data, ["dt", "feature", "message", "gc_ms", "gap_ms", "rss_mb", "sessions", "budget_pct"]);
}

// ── memory ──────────────────────────────────────────────────────────────────

async function cmdMemory(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "1 HOUR"));
  const source = getSourceForRegion(region);

  console.log(`📈 Memory Trend — ${region} (last ${duration})\n`);

  const result = await runSql(`
    SELECT
      toStartOfInterval(dt, INTERVAL 5 MINUTE) AS time,
      round(avg(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')), 0) AS rss_mb,
      round(avg(JSONExtract(raw, 'heapUsedMB', 'Nullable(Float64)')), 0) AS heap_mb,
      round(avg(JSONExtract(raw, 'externalMB', 'Nullable(Float64)')), 0) AS external_mb,
      round(avg(JSONExtract(raw, 'arrayBuffersMB', 'Nullable(Float64)')), 0) AS arraybuf_mb,
      round(avg(JSONExtract(raw, 'activeSessions', 'Nullable(Float64)')), 0) AS sessions
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
    GROUP BY time
    ORDER BY time
  `);

  printTable(result.data);

  if (result.data.length >= 2) {
    const first = result.data[0];
    const last = result.data[result.data.length - 1];
    const rssGrowth = Number(last.rss_mb) - Number(first.rss_mb);
    const minutes = result.data.length * 5;
    const rate = rssGrowth / minutes;
    console.log(
      `\n  RSS growth: ${first.rss_mb}MB → ${last.rss_mb}MB (${rssGrowth > 0 ? "+" : ""}${rssGrowth}MB over ~${minutes}min)`,
    );
    console.log(`  Rate: ~${rate.toFixed(1)} MB/min`);
    if (rate > 0) {
      const toGb = (1024 - Number(last.rss_mb)) / rate;
      console.log(`  Est. time to 1GB: ${toGb.toFixed(0)} min (${(toGb / 60).toFixed(1)} hrs)`);
    }
  }
}

// ── gc ───────────────────────────────────────────────────────────────────────

async function cmdGc(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "1 HOUR"));
  const source = getSourceForRegion(region);

  console.log(`🗑️ GC Probe Analysis — ${region} (last ${duration})\n`);

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)') AS gc_ms,
      JSONExtract(raw, 'freedMB', 'Nullable(Int32)') AS freed_mb,
      JSONExtract(raw, 'heapBeforeMB', 'Nullable(Int32)') AS heap_before,
      JSONExtract(raw, 'heapAfterMB', 'Nullable(Int32)') AS heap_after,
      JSONExtract(raw, 'rssMB', 'Nullable(Int32)') AS rss_mb,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'gc-probe'
    ORDER BY dt
  `);

  printTable(result.data);

  if (result.data.length > 0) {
    const avgGc = result.data.reduce((sum, r) => sum + Number(r.gc_ms || 0), 0) / result.data.length;
    const maxGc = Math.max(...result.data.map((r) => Number(r.gc_ms || 0)));
    console.log(
      `\n  Average GC: ${avgGc.toFixed(1)}ms | Max GC: ${maxGc.toFixed(1)}ms | Probes: ${result.data.length}`,
    );
    if (maxGc > 100) {
      console.log(`  ⚠️ Max GC > 100ms — GC is contributing to event loop blocking`);
    } else {
      console.log(`  ✅ GC pauses are within acceptable range`);
    }
  }
}

// ── gaps ─────────────────────────────────────────────────────────────────────

async function cmdGaps(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "6 HOUR"));
  const source = getSourceForRegion(region);

  console.log(`⏱️ Event Loop Gaps — ${region} (last ${duration})\n`);

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'gapMs', 'Nullable(Float64)') AS gap_ms,
      JSONExtract(raw, 'actualMs', 'Nullable(Float64)') AS actual_ms,
      JSONExtract(raw, 'rssMB', 'Nullable(Int32)') AS rss_mb,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'event-loop-gap'
    ORDER BY dt DESC
    LIMIT 50
  `);

  if (result.data.length === 0) {
    console.log("  ✅ No event loop gaps detected — the event loop was never blocked >1 second.");
  } else {
    printTable(result.data);
    console.log(`\n  ⚠️ ${result.data.length} gaps detected — something is blocking the event loop.`);
    console.log("  Cross-reference with slow-queries and gc-probes at the same timestamps.");
  }
}

// ── budget ───────────────────────────────────────────────────────────────────

async function cmdBudget(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"));
  const source = getSourceForRegion(region);

  console.log(`📊 Operation Budget — ${region} (last ${duration})\n`);

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'op_audioProcessing_ms', 'Nullable(Float64)') AS audio_ms,
      JSONExtract(raw, 'op_glassesMessage_ms', 'Nullable(Float64)') AS glasses_ms,
      JSONExtract(raw, 'op_appMessage_ms', 'Nullable(Float64)') AS app_msg_ms,
      JSONExtract(raw, 'op_displayRendering_ms', 'Nullable(Float64)') AS display_ms,
      JSONExtract(raw, 'opTotalMs', 'Nullable(Float64)') AS total_ms,
      JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)') AS budget_pct,
      JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)') AS mongo_ms,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions,
      JSONExtract(raw, 'rssMB', 'Nullable(Int32)') AS rss_mb
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
    ORDER BY dt
  `);

  printTable(result.data, [
    "dt",
    "sessions",
    "audio_ms",
    "glasses_ms",
    "app_msg_ms",
    "display_ms",
    "total_ms",
    "budget_pct",
    "mongo_ms",
    "rss_mb",
  ]);

  if (result.data.length > 0) {
    const avgBudget = result.data.reduce((s, r) => s + Number(r.budget_pct || 0), 0) / result.data.length;
    const maxBudget = Math.max(...result.data.map((r) => Number(r.budget_pct || 0)));
    console.log(`\n  Average budget: ${avgBudget.toFixed(1)}% | Max: ${maxBudget.toFixed(1)}%`);
    if (maxBudget > 50) {
      console.log("  🔴 Budget > 50% — application CPU work is consuming most of the event loop");
    } else if (maxBudget > 20) {
      console.log("  🟡 Budget 20-50% — moderate, watch for growth");
    } else {
      console.log("  ✅ Budget < 20% — healthy event loop headroom");
    }
  }
}

// ── slow-queries ────────────────────────────────────────────────────────────

async function cmdSlowQueries(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"));
  const source = getSourceForRegion(region);

  console.log(`🐢 Slow MongoDB Queries — ${region} (last ${duration})\n`);

  const summary = await runSql(`
    SELECT
      JSONExtract(raw, 'collection', 'Nullable(String)') AS collection,
      JSONExtract(raw, 'operation', 'Nullable(String)') AS operation,
      count() AS count,
      round(avg(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS avg_ms,
      max(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')) AS max_ms,
      round(sum(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS total_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'slow-query'
    GROUP BY collection, operation
    ORDER BY total_ms DESC
    LIMIT 20
  `);

  printTable(summary.data);
}

// ── cache ───────────────────────────────────────────────────────────────────

async function cmdCache(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const source = getSourceForRegion(region);

  console.log(`📦 App Cache Status — ${region}\n`);

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'count', 'Nullable(Int32)') AS apps_cached,
      JSONExtract(raw, 'refreshMs', 'Nullable(Float64)') AS refresh_ms,
      JSONExtract(raw, 'refreshCount', 'Nullable(Int32)') AS refresh_count
    FROM ${source}
    WHERE dt >= now() - INTERVAL 10 MINUTE
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'app-cache'
    ORDER BY dt DESC
    LIMIT 10
  `);

  printTable(result.data);
}

// ── incidents ───────────────────────────────────────────────────────────────

async function cmdIncidents(flags: Record<string, string>) {
  const limit = parseInt(getFlag(flags, "limit", "10"), 10);

  console.log(`🚨 Recent Incidents (last ${limit})\n`);

  const data = await fetchUptime(`/incidents?per_page=${limit}`);

  const rows = data.data.map((inc: any) => {
    const a = inc.attributes;
    const resolved = a.resolved_at ? a.resolved_at.slice(0, 19) : "ONGOING";
    return {
      started: a.started_at?.slice(0, 19) ?? "?",
      name: a.name ?? "?",
      cause: (a.cause ?? "?").slice(0, 40),
      status: a.resolved_at ? "✅" : "🔴",
      resolved,
    };
  });

  printTable(rows);
}

// ── sources ─────────────────────────────────────────────────────────────────

async function cmdSources() {
  console.log("📡 BetterStack Sources & Collectors\n");

  console.log("── Log Sources ──");
  const logRows = Object.entries(LOG_SOURCES).map(([key, s]) => ({
    key,
    id: s.id,
    name: s.name,
    table: s.logsTable,
  }));
  printTable(logRows);

  console.log("\n── Collectors (Infrastructure Metrics) ──");
  const collectorRows = Object.entries(COLLECTORS).map(([key, c]) => ({
    region: key,
    collector_id: c.collectorId,
    source_id: c.sourceId,
    name: c.name,
    cluster: c.clusterId,
  }));
  printTable(collectorRows);

  console.log("\n── Dashboards ──");
  const dashRows = Object.entries(DASHBOARDS).map(([key, d]) => ({
    key,
    id: d.id,
    name: d.name,
    url: d.url,
  }));
  printTable(dashRows);

  console.log("\n── Uptime Monitors ──");
  const monitorRows = Object.entries(UPTIME_MONITORS).map(([key, m]) => ({
    key,
    id: m.id,
    name: m.name,
  }));
  printTable(monitorRows);
}

// ── sql ─────────────────────────────────────────────────────────────────────

async function cmdSql(positional: string[]) {
  const sql = positional.join(" ");
  if (!sql) {
    console.error('Usage: bstack sql "SELECT ..."');
    process.exit(1);
  }

  console.log(`🔍 Raw SQL Query\n`);
  const result = await runSql(sql);
  printTable(result.data);

  if (result.statistics) {
    console.log(
      `\n  ${result.rows} rows | ${result.statistics.elapsed.toFixed(3)}s | ${(result.statistics.bytes_read / 1024 / 1024).toFixed(1)}MB scanned`,
    );
  }
}

// ── runbook ──────────────────────────────────────────────────────────────────

async function cmdRunbook(positional: string[]) {
  const name = positional[0];
  if (!name) {
    console.log("📖 Available Runbooks:\n");
    const fs = await import("fs");
    const path = await import("path");
    const runbookDir = path.join(import.meta.dir, "runbooks");
    try {
      const files = fs.readdirSync(runbookDir).filter((f: string) => f.endsWith(".md"));
      for (const f of files) {
        console.log(`  bstack runbook ${f.replace(".md", "")}`);
      }
    } catch {
      console.log("  (no runbooks found in cloud/tools/bstack/runbooks/)");
    }
    return;
  }

  const fs = await import("fs");
  const path = await import("path");
  const filePath = path.join(import.meta.dir, "runbooks", `${name}.md`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    console.log(content);
  } catch {
    console.error(`Runbook not found: ${name}`);
    console.error(`  Expected file: ${filePath}`);
    process.exit(1);
  }
}

// ── help ─────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
bstack — BetterStack CLI for MentraCloud SRE

Commands:
  bstack health                              Quick health check across all regions
  bstack diagnostics --region <r>            Full diagnostics (GC, gaps, MongoDB, budget)
  bstack crash-timeline --region <r>         What happened before the last crash
  bstack memory --region <r> [--duration 1h] Memory trend over time
  bstack gc --region <r> [--duration 1h]     GC probe analysis
  bstack gaps --region <r> [--duration 1h]   Event loop gap analysis
  bstack budget --region <r>                 Operation budget (CPU consumers)
  bstack slow-queries --region <r>           MongoDB slow query breakdown
  bstack cache --region <r>                  App cache status
  bstack incidents [--limit 10]              Recent uptime incidents
  bstack sources                             List all BetterStack sources/collectors
  bstack sql "SELECT ..."                    Raw ClickHouse SQL query
  bstack runbook <name>                      Open a runbook

Regions: ${getAllRegions().join(", ")}

Environment:
  BETTERSTACK_USERNAME    ClickHouse HTTP API username
  BETTERSTACK_PASSWORD    ClickHouse HTTP API password
  BETTERSTACK_API_TOKEN   Management API token (for uptime)
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { command, flags, positional } = parseArgs();

try {
  switch (command) {
    case "health":
      await cmdHealth();
      break;
    case "diagnostics":
    case "diag":
      await cmdDiagnostics(flags);
      break;
    case "crash-timeline":
    case "crash":
      await cmdCrashTimeline(flags);
      break;
    case "memory":
    case "mem":
      await cmdMemory(flags);
      break;
    case "gc":
      await cmdGc(flags);
      break;
    case "gaps":
      await cmdGaps(flags);
      break;
    case "budget":
      await cmdBudget(flags);
      break;
    case "slow-queries":
    case "slow":
      await cmdSlowQueries(flags);
      break;
    case "cache":
      await cmdCache(flags);
      break;
    case "incidents":
    case "inc":
      await cmdIncidents(flags);
      break;
    case "sources":
    case "src":
      await cmdSources();
      break;
    case "sql":
      await cmdSql(positional);
      break;
    case "runbook":
    case "rb":
      await cmdRunbook(positional);
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(1);
  }
} catch (error: any) {
  console.error(`\n❌ Error: ${error.message}`);
  if (error.message.includes("Unauthorized")) {
    console.error("   Check your BETTERSTACK_USERNAME and BETTERSTACK_PASSWORD environment variables.");
  }
  process.exit(1);
}
