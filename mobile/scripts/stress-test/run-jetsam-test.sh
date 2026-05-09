#!/usr/bin/env bash
# Drive an end-to-end iOS jetsam stress test on a connected device.
#
# What this does:
#   1. Streams the unified log to a file, filtering for STRESS:, jetsam,
#      our app crashes, and BLE state.
#   2. Replays a Maestro flow that opens the stress-test screen, mounts a
#      configurable number of dummy WebViews, and starts logging.
#   3. Optionally backgrounds the app, waits, then foregrounds and re-checks.
#   4. Pulls jetsam history out of the device after the run completes and
#      writes a parsed CSV next to the raw log.
#
# Usage:
#   ./run-jetsam-test.sh [scenario] [device]
#
# Scenarios (each maps to a Maestro flow + duration):
#   foreground   mount until jetsam, app stays foreground (default)
#   background   mount, then put app in background for 10 minutes
#   long         mount, then 60 minutes background
#   leak         mount 5 dummies, foreground, idle 60 minutes
#
# Device defaults to "Israelov" (iPhone 15) — change DEVICE_NAME below
# or pass as 2nd arg. Use `xcrun devicectl list devices` to see options.

set -euo pipefail

SCENARIO="${1:-foreground}"
DEVICE_NAME="${2:-Israelov}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.mentra.mentra}"
MB_PER_APP="${MB_PER_APP:-25}"
MAX_MOUNTS="${MAX_MOUNTS:-25}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M%S)-${SCENARIO}"
OUT_DIR="${ROOT}/scripts/stress-test/runs/${RUN_ID}"
mkdir -p "${OUT_DIR}"
LOG_FILE="${OUT_DIR}/raw.log"
META_FILE="${OUT_DIR}/meta.json"
CSV_FILE="${OUT_DIR}/events.csv"

echo "==> Run ID: ${RUN_ID}"
echo "==> Device: ${DEVICE_NAME}"
echo "==> Output: ${OUT_DIR}"

# -- 1. Sanity ---------------------------------------------------------------

# Resolve device identifier
DEVICE_ID="$(xcrun devicectl list devices 2>/dev/null \
  | awk -v name="${DEVICE_NAME}" '$1 == name { print $3 }')"
if [[ -z "${DEVICE_ID}" ]]; then
  echo "!! Device '${DEVICE_NAME}' not found. Connected devices:"
  xcrun devicectl list devices
  exit 1
fi
echo "==> Device ID: ${DEVICE_ID}"

# -- 2. Start log streaming in background ------------------------------------
# `log stream` on macOS attaches to a connected device when given --device.
# We filter for our process + jetsam kernel events. The predicate matches:
#  - Anything emitted by our app process
#  - Kernel jetsam reaper messages
#  - WebKit memory pressure
echo "==> Starting log stream → ${LOG_FILE}"
PRED='(processImagePath CONTAINS "Mentra") '\
'OR (eventMessage CONTAINS[c] "jetsam") '\
'OR (eventMessage CONTAINS[c] "memorystatus") '\
'OR (eventMessage CONTAINS[c] "STRESS:")'

# Run log stream against the device. Some macOS versions need `sudo` for
# device streaming; if so, you may want to pre-authorize sudo before running.
log stream \
  --predicate "${PRED}" \
  --style compact \
  --device "${DEVICE_ID}" \
  > "${LOG_FILE}" 2>&1 &
LOG_PID=$!
echo "==> log stream PID: ${LOG_PID}"
trap 'kill ${LOG_PID} 2>/dev/null || true' EXIT

# Give log stream a beat to attach
sleep 2

# -- 3. Make sure the app is launched ----------------------------------------
echo "==> Launching app on device..."
xcrun devicectl device process launch \
  --device "${DEVICE_ID}" \
  "${APP_BUNDLE_ID}" \
  > "${OUT_DIR}/launch.log" 2>&1 || {
    echo "!! Launch failed. Last few lines:"
    tail -10 "${OUT_DIR}/launch.log"
    exit 1
  }
sleep 3

# -- 4. Drive the UI via Maestro --------------------------------------------
# We let the user re-use the existing Maestro tooling. The flow opens the
# stress-test screen via super-mode konami, sets per-app MB, taps Start
# logging, then mounts MAX_MOUNTS dummies. Concrete YAML lives in
# .maestro/flows/99-stress-jetsam-${SCENARIO}.yaml — generated next to it
# if missing.
FLOW="${ROOT}/.maestro/flows/99-stress-jetsam-${SCENARIO}.yaml"
if [[ ! -f "${FLOW}" ]]; then
  echo "!! Maestro flow ${FLOW} not found. See README.md for how to create one."
  echo "!! Skipping UI drive — you'll need to drive the app manually for now."
else
  echo "==> Running Maestro flow: ${FLOW}"
  MAESTRO_APP_ID="${APP_BUNDLE_ID}" \
    maestro test \
      --device "${DEVICE_ID}" \
      -e MB_PER_APP="${MB_PER_APP}" \
      -e MAX_MOUNTS="${MAX_MOUNTS}" \
      "${FLOW}" \
      > "${OUT_DIR}/maestro.log" 2>&1 || {
        echo "!! Maestro flow failed — see ${OUT_DIR}/maestro.log"
      }
fi

# -- 5. Scenario-specific dwell time ----------------------------------------
case "${SCENARIO}" in
  foreground) DWELL=120 ;;        # 2 min watching events
  background) DWELL=600 ;;        # 10 min in BG
  long)       DWELL=3600 ;;       # 60 min in BG
  leak)       DWELL=3600 ;;       # 60 min idle FG
  *) echo "Unknown scenario: ${SCENARIO}"; exit 1 ;;
esac

if [[ "${SCENARIO}" == "background" || "${SCENARIO}" == "long" ]]; then
  echo "==> Sending app to background (you may need to lock the device manually)"
  echo "    Press the side button on the device now if not already locked."
fi

echo "==> Dwelling ${DWELL}s while events accumulate..."
# Periodically check that the app is still alive
END_AT=$(( $(date +%s) + DWELL ))
while (( $(date +%s) < END_AT )); do
  ALIVE="$(xcrun devicectl device info processes \
    --device "${DEVICE_ID}" 2>/dev/null \
    | grep -c "${APP_BUNDLE_ID}" || true)"
  echo "    [$(date +%H:%M:%S)] alive=${ALIVE} elapsed=$(( $(date +%s) - (END_AT - DWELL) ))s"
  if [[ "${ALIVE}" == "0" ]]; then
    echo "==> APP DIED at $(date +%H:%M:%S)"
    break
  fi
  sleep 30
done

# -- 6. Stop log stream and parse -------------------------------------------
echo "==> Stopping log stream..."
kill ${LOG_PID} 2>/dev/null || true
wait ${LOG_PID} 2>/dev/null || true

# -- 7. Save metadata --------------------------------------------------------
cat > "${META_FILE}" <<EOF
{
  "runId": "${RUN_ID}",
  "scenario": "${SCENARIO}",
  "device": "${DEVICE_NAME}",
  "deviceId": "${DEVICE_ID}",
  "appBundleId": "${APP_BUNDLE_ID}",
  "mbPerApp": ${MB_PER_APP},
  "maxMounts": ${MAX_MOUNTS},
  "dwellSeconds": ${DWELL},
  "startedAt": "$(date -Iseconds)"
}
EOF

# -- 8. Parse STRESS: lines into CSV ----------------------------------------
echo "==> Parsing events..."
{
  echo "ts,kind,packageName,residentMB,mounted,terminated,memwarn,raw"
  grep -E 'STRESS: (sample|event|mount|unmount-all)' "${LOG_FILE}" \
    | sed -E 's/.*STRESS: //' \
    | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = line.split(' ', 1)
    kind = parts[0]
    payload = parts[1] if len(parts) > 1 else ''
    try:
        d = json.loads(payload) if payload.startswith('{') else {'msg': payload}
    except Exception:
        d = {'msg': payload}
    print('{},{},{},{},{},{},{},{}'.format(
        d.get('at', ''),
        d.get('kind', kind),
        d.get('packageName', ''),
        d.get('residentMB', ''),
        d.get('mounted', ''),
        d.get('terminated', ''),
        d.get('memwarn', ''),
        json.dumps(d).replace(',', ';'),
    ))
" || true
} > "${CSV_FILE}"

# -- 9. Summarize ------------------------------------------------------------
echo ""
echo "===================================================================="
echo "Run complete: ${RUN_ID}"
echo "===================================================================="
echo "Raw log:  ${LOG_FILE}"
echo "Events:   ${CSV_FILE}"
echo "Meta:     ${META_FILE}"
echo ""
echo "Quick summary:"
echo "  STRESS lines:        $(grep -c 'STRESS:' "${LOG_FILE}" || echo 0)"
echo "  Jetsam mentions:     $(grep -ci jetsam "${LOG_FILE}" || echo 0)"
echo "  Memorystatus:        $(grep -ci memorystatus "${LOG_FILE}" || echo 0)"
echo "  Memwarn JS events:   $(grep -c '\"kind\": *\"memwarn\"' "${LOG_FILE}" || echo 0)"
echo "  Terminate JS events: $(grep -c '\"kind\": *\"terminate\"' "${LOG_FILE}" || echo 0)"
echo ""
echo "Last 5 STRESS samples:"
grep 'STRESS: sample' "${LOG_FILE}" | tail -5 || echo "  (none)"
