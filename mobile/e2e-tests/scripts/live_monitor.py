#!/usr/bin/env python3
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SIMULATED_GLASSES_TEXT = "Simulated glasses"
MIRROR_ROOT_RESOURCE_ID = "glasses-mirror-root"
MIRROR_TEXT_WALL_RESOURCE_ID = "glasses-mirror-text-wall"
MIRROR_LINE_RESOURCE_ID_PREFIX = "glasses-mirror-line-"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a continuous transcription monitor with a local dashboard.")
    parser.add_argument("--reference", required=True, help="Path to reference JSON")
    parser.add_argument("--playback-mode", choices=["adb", "local"], default="adb", help="How to play the reference audio")
    parser.add_argument("--device-audio-file", default=None, help="Device-side WAV path for adb mode, e.g. /sdcard/.../audio.wav")
    parser.add_argument("--local-audio-file", default=None, help="Local WAV path for local-speaker playback mode")
    parser.add_argument("--output-dir", required=True, help="Directory for monitor state and NDJSON history")
    parser.add_argument("--port", type=int, default=8765, help="Local dashboard port")
    parser.add_argument("--device", default=None, help="Optional adb/maestro device id")
    parser.add_argument("--poll-interval", type=float, default=0.25, help="Hierarchy poll interval in seconds")
    parser.add_argument(
        "--clear-hold-ms",
        type=int,
        default=22000,
        help="How long the mirror must stay empty before a new cycle starts. Use >20s to avoid resurrected stale captions.",
    )
    parser.add_argument("--drop-threshold-ms", type=int, default=5000, help="How long visible text can stagnate before a drop is recorded")
    parser.add_argument("--post-roll-ms", type=int, default=30000, help="Extra time after reference end before closing a cycle")
    parser.add_argument("--max-history", type=int, default=200, help="How many completed cycles and drop events to keep in memory")
    parser.add_argument("--match-early-tolerance-ms", type=int, default=250, help="Allow matches slightly before expected segment start")
    return parser.parse_args()


def normalize_text(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9\s]", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def tokenize(value: str) -> list[str]:
    return [token for token in normalize_text(value).split() if token]


def content_tokens(tokens: list[str]) -> list[str]:
    return [token for token in tokens if not token.isdigit() and len(token) > 1]


@dataclass
class OverlapStats:
    shared_count: int
    candidate_coverage: float
    reference_coverage: float
    first_ref_index: int
    last_ref_index: int


def compute_overlap(reference_text: str, candidate_text: str) -> OverlapStats | None:
    reference_tokens = content_tokens(tokenize(reference_text))
    candidate_tokens = content_tokens(tokenize(candidate_text))
    if not reference_tokens or not candidate_tokens:
        return None

    matched_indexes: list[int] = []
    search_start = 0
    for token in candidate_tokens:
        try:
            idx = reference_tokens.index(token, search_start)
        except ValueError:
            continue
        matched_indexes.append(idx)
        search_start = idx + 1

    if not matched_indexes:
        return None

    return OverlapStats(
        shared_count=len(matched_indexes),
        candidate_coverage=len(matched_indexes) / len(candidate_tokens),
        reference_coverage=len(matched_indexes) / len(reference_tokens),
        first_ref_index=matched_indexes[0],
        last_ref_index=matched_indexes[-1],
    )


def is_overlap_match(
    overlap: OverlapStats,
    min_shared_tokens: int = 3,
    min_candidate_coverage: float = 0.75,
    min_reference_coverage: float = 0.35,
) -> bool:
    if overlap.shared_count < min_shared_tokens:
        return False
    return overlap.candidate_coverage >= min_candidate_coverage or overlap.reference_coverage >= min_reference_coverage


def parse_hierarchy_output(raw_output: str) -> dict[str, Any]:
    json_start = raw_output.find("{")
    if json_start == -1:
        raise ValueError("Maestro hierarchy output did not contain JSON")
    return json.loads(raw_output[json_start:])


def find_parent_of_text(node: dict[str, Any], target: str) -> dict[str, Any] | None:
    children = node.get("children") or []
    for child in children:
        attributes = child.get("attributes") or {}
        if attributes.get("text") == target:
            return node
    for child in children:
        found = find_parent_of_text(child, target)
        if found:
            return found
    return None


def find_first_by_resource_id(node: dict[str, Any], resource_id: str) -> dict[str, Any] | None:
    attributes = node.get("attributes") or {}
    if attributes.get("resource-id") == resource_id:
        return node

    for child in node.get("children") or []:
        found = find_first_by_resource_id(child, resource_id)
        if found:
            return found
    return None


def node_from_xml(element: ET.Element) -> dict[str, Any]:
    return {
        "attributes": {
            "text": element.attrib.get("text", ""),
            "resource-id": element.attrib.get("resource-id", ""),
            "class": element.attrib.get("class", ""),
        },
        "children": [node_from_xml(child) for child in list(element)],
    }


def extract_visible_transcript_lines(hierarchy: dict[str, Any]) -> tuple[bool, list[str]]:
    mirror_root = find_first_by_resource_id(hierarchy, MIRROR_ROOT_RESOURCE_ID)
    text_wall = find_first_by_resource_id(hierarchy, MIRROR_TEXT_WALL_RESOURCE_ID)
    if mirror_root and text_wall:
        indexed_lines: list[tuple[int, str]] = []
        for child in text_wall.get("children") or []:
            attributes = child.get("attributes") or {}
            resource_id = attributes.get("resource-id") or ""
            if not resource_id.startswith(MIRROR_LINE_RESOURCE_ID_PREFIX):
                continue

            text = (attributes.get("text") or "").strip()
            if not text:
                continue

            try:
                index = int(resource_id.removeprefix(MIRROR_LINE_RESOURCE_ID_PREFIX))
            except ValueError:
                continue
            indexed_lines.append((index, text))

        indexed_lines.sort(key=lambda item: item[0])
        return True, [text for _, text in indexed_lines]

    parent = find_parent_of_text(hierarchy, SIMULATED_GLASSES_TEXT)
    if not parent:
        return False, []

    lines: list[str] = []
    for child in parent.get("children") or []:
        attributes = child.get("attributes") or {}
        text = (attributes.get("text") or "").strip()
        if not text or text == SIMULATED_GLASSES_TEXT:
            continue
        lines.append(text)
    return True, lines


def run_maestro_hierarchy(device: str | None) -> dict[str, Any]:
    env = os.environ.copy()
    env["JAVA_HOME"] = "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    env["PATH"] = f'{env["JAVA_HOME"]}/bin:/opt/homebrew/bin:' + env["PATH"]
    cmd = ["maestro"]
    if device:
        cmd.extend(["--device", device])
    cmd.extend(["hierarchy", "--no-ansi"])
    result = subprocess.run(cmd, check=True, capture_output=True, text=True, env=env)
    return parse_hierarchy_output(result.stdout)


def run_adb_hierarchy_dump(device: str | None) -> dict[str, Any]:
    last_error: Exception | None = None
    for _attempt in range(2):
        try:
            dump_cmd = ["adb"]
            if device:
                dump_cmd.extend(["-s", device])
            dump_cmd.extend(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"])
            subprocess.run(dump_cmd, check=True, capture_output=True, text=True)

            cat_cmd = ["adb"]
            if device:
                cat_cmd.extend(["-s", device])
            cat_cmd.extend(["shell", "cat", "/sdcard/window_dump.xml"])
            result = subprocess.run(cat_cmd, check=True, capture_output=True, text=True)
            xml_output = result.stdout.strip()
            if not xml_output.endswith("</hierarchy>"):
                raise ValueError("uiautomator dump did not contain a closing hierarchy tag")
            root = ET.fromstring(xml_output)
            return node_from_xml(root)
        except Exception as exc:
            last_error = exc
            time.sleep(0.1)
    assert last_error is not None
    raise last_error


def run_hierarchy(device: str | None) -> dict[str, Any]:
    try:
        return run_adb_hierarchy_dump(device)
    except Exception:
        return run_maestro_hierarchy(device)


def inject_audio(device: str | None, device_audio_file: str) -> None:
    cmd = ["adb"]
    if device:
        cmd.extend(["-s", device])
    cmd.extend(
        [
            "shell",
            "am",
            "broadcast",
            "-a",
            "com.mentra.TEST_INJECT_AUDIO",
            "--es",
            "filePath",
            device_audio_file,
            "-n",
            "com.mentra.mentra/com.mentra.core.testing.TestAudioReceiver",
        ]
    )
    subprocess.run(cmd, check=True)


def play_audio_locally(local_audio_file: str) -> subprocess.Popen[str]:
    return subprocess.Popen(["afplay", local_audio_file])


def read_reference(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_ndjson(path: Path, record: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=True) + "\n")


def trim_history(items: list[Any], max_items: int) -> list[Any]:
    if len(items) <= max_items:
        return items
    return items[-max_items:]


@dataclass
class SegmentState:
    id: int
    text: str
    normalized_text: str
    start_ms: int
    end_ms: int
    expected_ts_ms: int
    first_visible_ts_ms: int | None = None
    visible_delay_ms: int | None = None
    matched_expected_ts_ms: int | None = None
    matched_line: str | None = None


@dataclass
class CycleState:
    cycle_id: int
    injection_ts_ms: int
    cycle_end_ts_ms: int
    segments: list[SegmentState]
    matched_segment_count: int = 0
    first_visible_activity_ts_ms: int | None = None
    last_visible_change_ts_ms: int | None = None
    last_signature: str = ""
    drop_open: dict[str, Any] | None = None


class MonitorState:
    def __init__(self, output_dir: Path, max_history: int) -> None:
        self.output_dir = output_dir
        self.max_history = max_history
        self.lock = threading.Lock()
        self.started_at_ms = int(time.time() * 1000)
        self.status = "starting"
        self.status_detail = "booting"
        self.last_error: str | None = None
        self.mirror_visible = False
        self.current_visible_lines: list[str] = []
        self.last_snapshot_ts_ms: int | None = None
        self.clear_since_ts_ms: int | None = None
        self.current_cycle: CycleState | None = None
        self.next_cycle_id = 1
        self.completed_cycles: list[dict[str, Any]] = []
        self.delay_points: list[dict[str, Any]] = []
        self.drop_events: list[dict[str, Any]] = []
        self.last_events: list[dict[str, Any]] = []

    def append_event(self, kind: str, payload: dict[str, Any]) -> None:
        event = {"kind": kind, **payload}
        self.last_events.append(event)
        self.last_events = trim_history(self.last_events, 50)
        write_ndjson(self.output_dir / "monitor_events.ndjson", event)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "started_at_ms": self.started_at_ms,
                "status": self.status,
                "status_detail": self.status_detail,
                "last_error": self.last_error,
                "mirror_visible": self.mirror_visible,
                "current_visible_lines": list(self.current_visible_lines),
                "last_snapshot_ts_ms": self.last_snapshot_ts_ms,
                "clear_since_ts_ms": self.clear_since_ts_ms,
                "current_cycle": self.serialize_cycle(self.current_cycle),
                "completed_cycles": list(self.completed_cycles),
                "delay_points": list(self.delay_points),
                "drop_events": list(self.drop_events),
                "last_events": list(self.last_events),
            }

    @staticmethod
    def serialize_cycle(cycle: CycleState | None) -> dict[str, Any] | None:
        if cycle is None:
            return None
        return {
            "cycle_id": cycle.cycle_id,
            "injection_ts_ms": cycle.injection_ts_ms,
            "cycle_end_ts_ms": cycle.cycle_end_ts_ms,
            "matched_segment_count": cycle.matched_segment_count,
            "first_visible_activity_ts_ms": cycle.first_visible_activity_ts_ms,
            "last_visible_change_ts_ms": cycle.last_visible_change_ts_ms,
            "segments": [
                {
                    "id": segment.id,
                    "text": segment.text,
                    "expected_ts_ms": segment.expected_ts_ms,
                    "first_visible_ts_ms": segment.first_visible_ts_ms,
                    "visible_delay_ms": segment.visible_delay_ms,
                    "matched_expected_ts_ms": segment.matched_expected_ts_ms,
                    "matched_line": segment.matched_line,
                }
                for segment in cycle.segments
            ],
        }


class MonitorWorker:
    def __init__(self, args: argparse.Namespace, state: MonitorState, reference: list[dict[str, Any]]) -> None:
        self.args = args
        self.state = state
        self.reference = reference
        self.stop_event = threading.Event()
        self.reference_duration_ms = int(max(float(item["end"]) for item in reference) * 1000) if reference else 0
        self.playback_process: subprocess.Popen[str] | None = None

    def make_cycle(self, now_ms: int) -> CycleState:
        segments = [
            SegmentState(
                id=int(item["id"]),
                text=item["text"],
                normalized_text=normalize_text(item["text"]),
                start_ms=int(float(item["start"]) * 1000),
                end_ms=int(float(item["end"]) * 1000),
                expected_ts_ms=now_ms + int(float(item["start"]) * 1000),
            )
            for item in self.reference
        ]
        return CycleState(
            cycle_id=self.state.next_cycle_id,
            injection_ts_ms=now_ms,
            cycle_end_ts_ms=now_ms + self.reference_duration_ms + self.args.post_roll_ms,
            segments=segments,
        )

    def finalize_cycle(self, cycle: CycleState, now_ms: int) -> None:
        if cycle.drop_open is not None:
            drop_duration_ms = now_ms - int(cycle.drop_open["started_at_ms"])
            if drop_duration_ms >= self.args.drop_threshold_ms:
                drop_event = {
                    "cycle_id": cycle.cycle_id,
                    "started_at_ms": int(cycle.drop_open["started_at_ms"]),
                    "ended_at_ms": now_ms,
                    "duration_ms": drop_duration_ms,
                }
                self.state.drop_events.append(drop_event)
                self.state.drop_events = trim_history(self.state.drop_events, self.state.max_history)
                self.state.append_event("drop_event", drop_event)

        matched_delays = [segment.visible_delay_ms for segment in cycle.segments if segment.visible_delay_ms is not None]
        summary = {
            "cycle_id": cycle.cycle_id,
            "injection_ts_ms": cycle.injection_ts_ms,
            "cycle_end_ts_ms": cycle.cycle_end_ts_ms,
            "matched_segments": cycle.matched_segment_count,
            "reference_segments": len(cycle.segments),
            "average_visible_delay_ms": int(sum(matched_delays) / len(matched_delays)) if matched_delays else None,
            "max_visible_delay_ms": max(matched_delays) if matched_delays else None,
        }
        self.state.completed_cycles.append(summary)
        self.state.completed_cycles = trim_history(self.state.completed_cycles, self.state.max_history)
        self.state.append_event("cycle_completed", summary)
        write_ndjson(self.state.output_dir / "cycle_reports.ndjson", {"summary": summary, "segments": self.state.serialize_cycle(cycle)["segments"]})

    def expected_visible_ts_ms(self, segment: SegmentState, overlap: OverlapStats) -> int:
        reference_tokens = content_tokens(tokenize(segment.text))
        if not reference_tokens:
            return segment.expected_ts_ms

        progress_fraction = (overlap.last_ref_index + 1) / len(reference_tokens)
        progress_fraction = min(max(progress_fraction, 0.0), 1.0)
        segment_duration_ms = max(segment.end_ms - segment.start_ms, 0)
        return segment.expected_ts_ms + int(segment_duration_ms * progress_fraction)

    def maybe_record_match(self, cycle: CycleState, now_ms: int, visible_lines: list[str]) -> None:
        for segment in cycle.segments:
            if segment.first_visible_ts_ms is not None:
                continue
            for line in visible_lines:
                overlap = compute_overlap(segment.text, line)
                if overlap is None or not is_overlap_match(overlap):
                    continue

                expected_visible_ts_ms = self.expected_visible_ts_ms(segment, overlap)
                if now_ms < expected_visible_ts_ms - self.args.match_early_tolerance_ms:
                    continue

                segment.first_visible_ts_ms = now_ms
                segment.matched_expected_ts_ms = expected_visible_ts_ms
                segment.visible_delay_ms = max(0, now_ms - expected_visible_ts_ms)
                segment.matched_line = line
                cycle.matched_segment_count += 1
                point = {
                    "cycle_id": cycle.cycle_id,
                    "segment_id": segment.id,
                    "ts_ms": now_ms,
                    "delay_ms": segment.visible_delay_ms,
                    "expected_ts_ms": expected_visible_ts_ms,
                }
                self.state.delay_points.append(point)
                self.state.delay_points = trim_history(self.state.delay_points, self.state.max_history * 6)
                self.state.append_event(
                    "segment_match",
                    point
                    | {
                        "matched_line": line,
                        "candidate_coverage": overlap.candidate_coverage,
                        "reference_coverage": overlap.reference_coverage,
                    },
                )
                break

    def update_drop_tracking(self, cycle: CycleState, now_ms: int, normalized_lines: list[str]) -> None:
        signature = "|".join(normalized_lines)
        if signature != cycle.last_signature:
            cycle.last_signature = signature
            cycle.last_visible_change_ts_ms = now_ms
            cycle.drop_open = None
            if normalized_lines and cycle.first_visible_activity_ts_ms is None:
                cycle.first_visible_activity_ts_ms = now_ms
            return

        if cycle.first_visible_activity_ts_ms is None or cycle.last_visible_change_ts_ms is None:
            return

        stagnant_for_ms = now_ms - cycle.last_visible_change_ts_ms
        if stagnant_for_ms < self.args.drop_threshold_ms:
            return

        if cycle.drop_open is None:
            cycle.drop_open = {
                "cycle_id": cycle.cycle_id,
                "started_at_ms": cycle.last_visible_change_ts_ms,
            }

    def monitor_loop(self) -> None:
        while not self.stop_event.is_set():
            snapshot_started = time.time()
            now_ms = int(snapshot_started * 1000)
            try:
                hierarchy = run_hierarchy(self.args.device)
                mirror_visible, lines = extract_visible_transcript_lines(hierarchy)
                normalized_lines = [normalize_text(line) for line in lines]

                with self.state.lock:
                    self.state.mirror_visible = mirror_visible
                    self.state.current_visible_lines = lines
                    self.state.last_snapshot_ts_ms = now_ms

                    write_ndjson(
                        self.state.output_dir / "live_snapshots.ndjson",
                        {
                            "ts_ms": now_ms,
                            "mirror_visible": mirror_visible,
                            "visible_lines": lines,
                            "normalized_visible_lines": normalized_lines,
                        },
                    )

                    if mirror_visible and not lines:
                        if self.state.clear_since_ts_ms is None:
                            self.state.clear_since_ts_ms = now_ms
                    else:
                        self.state.clear_since_ts_ms = None

                    cycle = self.state.current_cycle
                    if cycle is not None:
                        self.maybe_record_match(cycle, now_ms, lines)
                        self.update_drop_tracking(cycle, now_ms, normalized_lines)
                        if now_ms >= cycle.cycle_end_ts_ms:
                            self.finalize_cycle(cycle, now_ms)
                            self.state.current_cycle = None
                            self.state.status = "waiting_for_clear"
                            self.state.status_detail = "cycle finished, waiting for empty mirror"
                    else:
                        if not mirror_visible:
                            self.state.status = "waiting_for_mirror"
                            self.state.status_detail = "Simulated glasses mirror is not visible"
                        elif self.state.clear_since_ts_ms is not None and now_ms - self.state.clear_since_ts_ms >= self.args.clear_hold_ms:
                            cycle = self.make_cycle(now_ms)
                            if self.args.playback_mode == "adb":
                                assert self.args.device_audio_file
                                inject_audio(self.args.device, self.args.device_audio_file)
                            else:
                                assert self.args.local_audio_file
                                self.playback_process = play_audio_locally(self.args.local_audio_file)
                            self.state.current_cycle = cycle
                            self.state.next_cycle_id += 1
                            self.state.status = "running_cycle"
                            self.state.status_detail = f"cycle {cycle.cycle_id} active"
                            self.state.append_event(
                                "cycle_started",
                                {
                                    "cycle_id": cycle.cycle_id,
                                    "injection_ts_ms": cycle.injection_ts_ms,
                                    "cycle_end_ts_ms": cycle.cycle_end_ts_ms,
                                },
                            )
                            write_ndjson(
                                self.state.output_dir / "cycle_reports.ndjson",
                                {
                                    "event": "cycle_started",
                                    "cycle_id": cycle.cycle_id,
                                    "injection_ts_ms": cycle.injection_ts_ms,
                                    "cycle_end_ts_ms": cycle.cycle_end_ts_ms,
                                },
                            )
                            self.state.clear_since_ts_ms = None
                        else:
                            self.state.status = "waiting_for_clear"
                            self.state.status_detail = "waiting for empty mirror before next injection"

                    self.state.last_error = None
            except Exception as exc:
                with self.state.lock:
                    self.state.last_error = str(exc)
                    self.state.status = "error"
                    self.state.status_detail = "collector error"
                    self.state.append_event("error", {"ts_ms": now_ms, "message": str(exc)})

            elapsed = time.time() - snapshot_started
            sleep_for = max(self.args.poll_interval - elapsed, 0.01)
            self.stop_event.wait(sleep_for)

        if self.playback_process is not None and self.playback_process.poll() is None:
            self.playback_process.terminate()


HTML_PAGE = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MentraOS E2E Monitor</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b1220; color: #e5eef9; }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .card { background: #121b2d; border: 1px solid #24314f; border-radius: 12px; padding: 14px; }
    .wide { grid-column: span 2; }
    h1, h2 { margin: 0 0 12px; font-weight: 700; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    h2 { font-size: 16px; }
    .label { color: #89a1c6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .mono { font-family: ui-monospace, SFMono-Regular, monospace; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; background: #203254; }
    .ok { background: #184f33; color: #b6f2cf; }
    .warn { background: #574115; color: #f7e2a2; }
    .bad { background: #5e1f25; color: #ffbec4; }
    svg { width: 100%; height: 280px; background: #0f1728; border-radius: 10px; border: 1px solid #24314f; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid #24314f; vertical-align: top; }
    th { color: #89a1c6; font-weight: 600; }
    ul { margin: 0; padding-left: 18px; }
    .small { font-size: 12px; color: #9eb3d1; }
    .lines { white-space: pre-wrap; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MentraOS Live Transcription Monitor</h1>
    <div class="grid">
      <div class="card"><div class="label">Status</div><div id="status" class="value">Loading...</div><div id="statusDetail" class="small"></div></div>
      <div class="card"><div class="label">Mirror Visible</div><div id="mirror" class="value">-</div><div id="snapshotAge" class="small"></div></div>
      <div class="card"><div class="label">Current Cycle</div><div id="cycle" class="value">-</div><div id="cycleDetail" class="small"></div></div>
      <div class="card"><div class="label">Drop Events &gt; 5s</div><div id="dropCount" class="value">0</div><div class="small">Across all monitor cycles</div></div>
    </div>

    <div class="grid">
      <div class="card wide">
        <h2>Visible Overlap Delay</h2>
        <svg id="chart" viewBox="0 0 900 280" preserveAspectRatio="none"></svg>
        <div class="small">Each point measures when the visible text catches up to the portion of the phrase already on screen, not the raw sentence start.</div>
      </div>
      <div class="card">
        <h2>Live Mirror Text</h2>
        <div id="visibleLines" class="lines small"></div>
      </div>
      <div class="card">
        <h2>Current Cycle Delays</h2>
        <table id="segmentTable"><thead><tr><th>Seg</th><th>Overlap Delay</th><th>Matched</th></tr></thead><tbody></tbody></table>
      </div>
    </div>

    <div class="grid">
      <div class="card wide">
        <h2>Drop Events</h2>
        <table id="dropTable"><thead><tr><th>Cycle</th><th>Started</th><th>Ended</th><th>Duration</th></tr></thead><tbody></tbody></table>
      </div>
      <div class="card wide">
        <h2>Recent Cycles</h2>
        <table id="cycleTable"><thead><tr><th>Cycle</th><th>Matched</th><th>Avg Overlap Delay</th><th>Max Overlap Delay</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>
  <script>
    function fmtTs(ms) {
      if (!ms) return '-';
      return new Date(ms).toLocaleTimeString();
    }
    function fmtMs(ms) {
      if (ms === null || ms === undefined) return '-';
      return `${Math.round(ms)} ms`;
    }
    function ageFrom(ms) {
      if (!ms) return '-';
      const delta = Math.max(0, Date.now() - ms);
      return `${(delta / 1000).toFixed(1)}s ago`;
    }
    function statusClass(status) {
      if (status === 'running_cycle') return 'pill ok';
      if (status === 'error') return 'pill bad';
      return 'pill warn';
    }
    function renderChart(points) {
      const svg = document.getElementById('chart');
      const width = 900;
      const height = 280;
      const pad = 36;
      const innerW = width - pad * 2;
      const innerH = height - pad * 2;
      if (!points.length) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="#89a1c6" font-size="16">Waiting for delay points...</text>`;
        return;
      }
      const minTs = Math.min(...points.map(p => p.ts_ms));
      const maxTs = Math.max(...points.map(p => p.ts_ms));
      const maxDelay = Math.max(10000, ...points.map(p => p.delay_ms || 0));
      const xFor = (ts) => pad + ((ts - minTs) / Math.max(1, maxTs - minTs)) * innerW;
      const yFor = (delay) => height - pad - (delay / maxDelay) * innerH;
      const circles = points.map((point) => {
        const color = ['#7dd3fc', '#86efac', '#fca5a5', '#fcd34d', '#c4b5fd', '#fdba74'][(point.segment_id - 1) % 6];
        return `<circle cx="${xFor(point.ts_ms)}" cy="${yFor(point.delay_ms)}" r="5" fill="${color}"><title>Cycle ${point.cycle_id}, segment ${point.segment_id}: ${Math.round(point.delay_ms)} ms</title></circle>`;
      }).join('');
      const yTicks = [0, maxDelay / 2, maxDelay].map((delay) => `
        <g>
          <line x1="${pad}" x2="${width - pad}" y1="${yFor(delay)}" y2="${yFor(delay)}" stroke="#24314f" stroke-dasharray="4 4" />
          <text x="4" y="${yFor(delay) + 4}" fill="#89a1c6" font-size="12">${Math.round(delay)} ms</text>
        </g>
      `).join('');
      svg.innerHTML = `
        <rect x="0" y="0" width="${width}" height="${height}" fill="#0f1728"></rect>
        ${yTicks}
        <line x1="${pad}" x2="${pad}" y1="${pad}" y2="${height - pad}" stroke="#5f739b"></line>
        <line x1="${pad}" x2="${width - pad}" y1="${height - pad}" y2="${height - pad}" stroke="#5f739b"></line>
        ${circles}
      `;
    }
    function fillRows(id, rows) {
      const tbody = document.querySelector(`#${id} tbody`);
      tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="4" class="small">No data yet</td></tr>';
    }
    async function refresh() {
      const response = await fetch('/state');
      const state = await response.json();
      document.getElementById('status').innerHTML = `<span class="${statusClass(state.status)}">${state.status}</span>`;
      document.getElementById('statusDetail').textContent = state.status_detail || '';
      document.getElementById('mirror').textContent = state.mirror_visible ? 'Yes' : 'No';
      document.getElementById('snapshotAge').textContent = `Last snapshot ${ageFrom(state.last_snapshot_ts_ms)}`;
      document.getElementById('cycle').textContent = state.current_cycle ? `#${state.current_cycle.cycle_id}` : '-';
      document.getElementById('cycleDetail').textContent = state.current_cycle ? `Ends ${fmtTs(state.current_cycle.cycle_end_ts_ms)}` : 'Waiting for next cycle';
      document.getElementById('dropCount').textContent = String(state.drop_events.length);
      document.getElementById('visibleLines').textContent = state.current_visible_lines.length ? state.current_visible_lines.join('\\n') : '(empty mirror)';

      const segmentRows = (state.current_cycle?.segments || []).map((segment) =>
        `<tr><td>${segment.id}</td><td>${fmtMs(segment.visible_delay_ms)}</td><td class="small">${segment.matched_line || '-'}</td></tr>`
      );
      fillRows('segmentTable', segmentRows);

      const dropRows = state.drop_events.slice().reverse().map((drop) =>
        `<tr><td>${drop.cycle_id}</td><td>${fmtTs(drop.started_at_ms)}</td><td>${fmtTs(drop.ended_at_ms)}</td><td>${fmtMs(drop.duration_ms)}</td></tr>`
      );
      fillRows('dropTable', dropRows);

      const cycleRows = state.completed_cycles.slice().reverse().map((cycle) =>
        `<tr><td>${cycle.cycle_id}</td><td>${cycle.matched_segments}/${cycle.reference_segments}</td><td>${fmtMs(cycle.average_visible_delay_ms)}</td><td>${fmtMs(cycle.max_visible_delay_ms)}</td></tr>`
      );
      fillRows('cycleTable', cycleRows);

      renderChart(state.delay_points);
    }
    refresh().catch(console.error);
    setInterval(() => refresh().catch(console.error), 1000);
  </script>
</body>
</html>
"""


class MonitorHandler(BaseHTTPRequestHandler):
    monitor_state: MonitorState | None = None

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            body = HTML_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/state":
            assert self.monitor_state is not None
            body = json.dumps(self.monitor_state.snapshot()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> int:
    args = parse_args()
    if args.playback_mode == "adb" and not args.device_audio_file:
        raise SystemExit("--device-audio-file is required in adb playback mode")
    if args.playback_mode == "local" and not args.local_audio_file:
        raise SystemExit("--local-audio-file is required in local playback mode")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    reference = read_reference(Path(args.reference))

    state = MonitorState(output_dir=output_dir, max_history=args.max_history)
    worker = MonitorWorker(args=args, state=state, reference=reference)

    MonitorHandler.monitor_state = state
    server = ThreadingHTTPServer(("127.0.0.1", args.port), MonitorHandler)
    server.daemon_threads = True

    worker_thread = threading.Thread(target=worker.monitor_loop, daemon=True)
    worker_thread.start()

    print(f"Dashboard: http://127.0.0.1:{args.port}")
    print(f"Output dir: {output_dir}")
    print("Press Ctrl-C to stop.")

    def handle_signal(_signum: int, _frame: Any) -> None:
        worker.stop_event.set()
        server.shutdown()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        worker.stop_event.set()
        worker_thread.join(timeout=5)
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
