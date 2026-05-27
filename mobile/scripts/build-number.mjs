// Single source of truth for build numbers across iOS and Android.
//
// Strategy: derive from minute-resolution wall clock since EPOCH_OFFSET_MS,
// plus a BASELINE that exceeds the highest versionCode ever submitted to
// either store. This guarantees:
//   - Strictly monotonic across CI + local + any machine (Date.now() always advances).
//   - Safe under both platform caps (iOS 18-char limit, Android 2.1B int32 cap).
//   - No committed counter to bump, so no merge conflicts on parallel PRs.
//
// Same number is used for both iOS CFBundleVersion and Android versionCode.

// Jan 1 2025 UTC. Picked once and never changed — moving it would break monotonicity.
const EPOCH_OFFSET_MS = Date.UTC(2025, 0, 1);

// Floor that must be exceeded by every derived build number. Set well above
// the highest versionCode ever uploaded to a store (latest was 275 as of
// the migration). Never lower this.
const BASELINE = 100_000;

export function getBuildNumber() {
  const minutesSinceOffset = Math.floor((Date.now() - EPOCH_OFFSET_MS) / 60_000);
  return BASELINE + minutesSinceOffset;
}
