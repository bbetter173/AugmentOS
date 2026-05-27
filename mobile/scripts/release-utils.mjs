// Shared helpers for release scripts.

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-platform summary file paths. release-all.mjs reads these at the end so
 * both summaries land at the bottom of the terminal, not buried under output
 * from the next script.
 */
export const SUMMARY_PATHS = {
  android: path.resolve('build/release-summary-android.txt'),
  ios: path.resolve('build/release-summary-ios.txt'),
};

/**
 * Print summary lines to stdout AND persist them to the platform's summary
 * file. Pass an array of pre-formatted lines (no leading/trailing newlines).
 */
export async function writeSummary(platform, lines) {
  const filePath = SUMMARY_PATHS[platform];
  if (!filePath) throw new Error(`Unknown platform: ${platform}`);
  const block = ['━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ...lines, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];
  console.log('\n' + block.join('\n') + '\n');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, block.join('\n') + '\n');
}

/**
 * Run an async fn with retries and exponential backoff. Designed for network
 * calls (gh release upload, fastlane google_play, altool, sentry-cli) that
 * occasionally fail with transient TLS/connection errors.
 *
 * Usage:
 *   await withRetry('Upload APK', () => $`gh release upload ...`);
 */
export async function withRetry(label, fn, { attempts = 4, baseDelayMs = 3000, shouldRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      if (shouldRetry && !shouldRetry(err)) {
        console.warn(`\n⚠️  ${label} failed (attempt ${attempt}): ${err?.message || err}`);
        console.warn(`   Error is not retryable, aborting.`);
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`\n⚠️  ${label} failed (attempt ${attempt}/${attempts}): ${err?.message || err}`);
      console.warn(`   Retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }
  console.error(`\n❌ ${label} failed after ${attempts} attempts.`);
  throw lastErr;
}

/**
 * Predicate for withRetry: only retry when the error output looks like a
 * transient Sentry network/TLS failure during source-map upload.
 *
 * Real build errors (Swift compile failures, missing files, etc.) will not
 * match these patterns and will fail immediately.
 */
export function isSentryTransientError(err) {
  const haystack = [
    err?.message,
    err?.stdout,
    err?.stderr,
  ].filter(Boolean).join('\n');
  if (!haystack) return false;

  const patterns = [
    /sentry-cli.*API request failed/i,
    /sentry-cli.*Failure when receiving data from the peer/i,
    /sentry-cli.*OpenSSL.*bad record mac/i,
    /sentry-cli.*connection (?:reset|refused|timed out)/i,
    /sentry-cli.*(?:ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN)/i,
    /sentry-cli.*502 Bad Gateway/i,
    /sentry-cli.*503 Service Unavailable/i,
    /sentry-cli.*504 Gateway Timeout/i,
  ];
  return patterns.some((re) => re.test(haystack));
}
