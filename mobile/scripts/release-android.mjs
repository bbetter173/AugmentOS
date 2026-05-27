#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
import { withRetry, isSentryTransientError, writeSummary } from './release-utils.mjs';
import { getBuildNumber } from './build-number.mjs';
import { cp, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseVersion(version) {
  const [major, minor] = version.split('.');
  return { major, minor };
}

function ghTag(version) {
  const { major, minor } = parseVersion(version);
  return `v${major}.${minor}`;
}

function apkPrefix(version) {
  const { major, minor } = parseVersion(version);
  return `Mentra_${major}p${minor}`;
}

// ── Step 1: Read version from .env ────────────────────────────────────────────

console.log('\n━━━ Step 1: Reading version from .env ━━━');
await setBuildEnv();

const version = process.env.EXPO_PUBLIC_MENTRAOS_VERSION;
if (!version) {
  console.error('EXPO_PUBLIC_MENTRAOS_VERSION not found in .env');
  process.exit(1);
}

const tag = ghTag(version);
const prefix = apkPrefix(version);
console.log(`Version: ${version} → tag: ${tag}, prefix: ${prefix}`);

// ── Step 2: Derive build number ──────────────────────────────────────────────

// app.config.ts already reads this via getBuildNumber(); we just capture the
// same value here for logging/summary so it matches what gets baked in.
const versionCode = getBuildNumber();
console.log(`versionCode: ${versionCode}`);

// ── Step 3: Prebuild + bundle ────────────────────────────────────────────────

console.log('\n━━━ Step 3: Prebuild + bundle ━━━');
process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a';

// Clean android/ to avoid cached version number issues
await $({ stdio: 'inherit' })`rm -rf android`;
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;
await $({ stdio: 'inherit' })`bun expo export --platform android --clear`;

// Prebuild can leave a stale autolinking.json with the wrong packageName
// (com.mentra instead of com.mentra.mentra), which makes the generated
// ReactNativeApplicationEntryPoint reference a non-existent BuildConfig.
// Delete it so gradle's settings phase regenerates it against the final build.gradle.
await $({ stdio: 'inherit' })`rm -rf android/build/generated/autolinking`;

// ── Step 4: Copy fastlane config into android/ ────────────────────────────────

console.log('\n━━━ Step 4: Copying fastlane config into android/ ━━━');
const fastlaneSrc = path.resolve('ci/fastlane-android');
const fastlaneDst = path.resolve('android', 'fastlane');
await mkdir(fastlaneDst, { recursive: true });
for (const file of ['Fastfile', 'Appfile', 'Gemfile']) {
  await cp(path.join(fastlaneSrc, file), path.join(fastlaneDst, file));
}
// Also copy Gemfile to android/ root so `bundle exec` works from android/ cwd
await cp(path.join(fastlaneSrc, 'Gemfile'), path.resolve('android', 'Gemfile'));
console.log('Fastlane config copied to android/fastlane/');

// ── Step 5: Build APK ─────────────────────────────────────────────────────────

console.log('\n━━━ Step 5: Building APK ━━━');
// stdio piped manually so withRetry's predicate can inspect output for transient
// Sentry/network errors; output still streams live to the terminal.
await withRetry(
  'gradlew assembleRelease',
  () => {
    const p = $({ cwd: 'android' })`./gradlew assembleRelease`;
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    return p;
  },
  { shouldRetry: isSentryTransientError }
);

const apkPath = path.resolve('android/app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apkPath)) {
  console.error('APK not found at expected path:', apkPath);
  process.exit(1);
}
console.log('APK built successfully');

// ── Step 6: Determine beta number & rename APK ───────────────────────────────

console.log('\n━━━ Step 6: Determining beta number ━━━');

// Check gh CLI is available and authenticated
try {
  await $`gh auth status`;
} catch {
  console.error('gh CLI is not authenticated. Run `gh auth login` first.');
  process.exit(1);
}

let betaNumber = 1;
let releaseExists = false;

try {
  const assetsJson = (await $`gh release view ${tag} --json assets -q .assets`).stdout.trim();
  releaseExists = true;
  if (assetsJson && assetsJson !== 'null') {
    const assets = JSON.parse(assetsJson);
    const betaNumbers = assets
      .map(a => a.name)
      .filter(name => name.startsWith(prefix) && name.endsWith('.apk'))
      .map(name => {
        const match = name.match(/_Beta_(\d+)\.apk$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);
    if (betaNumbers.length > 0) {
      betaNumber = Math.max(...betaNumbers) + 1;
    }
  }
} catch {
  // Release doesn't exist yet
  releaseExists = false;
}

const apkName = `${prefix}_Beta_${betaNumber}.apk`;
const renamedApkPath = path.resolve('android/app/build/outputs/apk/release', apkName);
await $`mv ${apkPath} ${renamedApkPath}`;
console.log(`APK renamed to: ${apkName} (Beta ${betaNumber})`);

// ── Step 7: Upload APK to GitHub release ──────────────────────────────────────

console.log('\n━━━ Step 7: Uploading APK to GitHub release ━━━');

if (!releaseExists) {
  console.log(`Creating new pre-release: ${tag}`);
  await withRetry('gh release create', () =>
    $({ stdio: 'inherit' })`gh release create ${tag} --prerelease --title ${tag} --notes ${'Pre-release ' + tag}`
  );
}

await withRetry('gh release upload (APK)', () =>
  $({ stdio: 'inherit' })`gh release upload ${tag} ${renamedApkPath} --clobber`
);
console.log(`Uploaded ${apkName} to release ${tag}`);

// ── Step 8: Build AAB ─────────────────────────────────────────────────────────

console.log('\n━━━ Step 8: Building AAB ━━━');
await withRetry(
  'gradlew bundleRelease',
  () => {
    const p = $({ cwd: 'android' })`./gradlew bundleRelease`;
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    return p;
  },
  { shouldRetry: isSentryTransientError }
);

const aabPath = path.resolve('android/app/build/outputs/bundle/release/app-release.aab');
if (!existsSync(aabPath)) {
  console.error('AAB not found at expected path:', aabPath);
  process.exit(1);
}
console.log('AAB built successfully');

// ── Step 9: Upload AAB to Google Play ─────────────────────────────────────────

console.log('\n━━━ Step 9: Uploading AAB to Google Play ━━━');

const keyPath = process.env.GOOGLE_PLAY_JSON_KEY || path.join(os.homedir(), '.mentra', 'credentials', 'google-play-key.json');

if (!existsSync(keyPath)) {
  console.log(`⚠️  Google Play key not found at ${keyPath}`);
  console.log('   Skipping Google Play upload.');
  console.log('   To enable: place service account key at ~/.mentra/credentials/google-play-key.json');
  console.log('   or set GOOGLE_PLAY_JSON_KEY env var.');
} else {
  process.env.GOOGLE_PLAY_JSON_KEY = keyPath;
  // Install gems and run fastlane
  await $({ stdio: 'inherit', cwd: 'android' })`bundle install`;
  await withRetry('fastlane google_play', () =>
    $({ stdio: 'inherit', cwd: 'android' })`bundle exec fastlane google_play`
  );
  console.log('AAB uploaded to Google Play (internal track)');
}

// ── Done ──────────────────────────────────────────────────────────────────────

const repoName = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`).stdout.trim();
const apkUrl = `https://github.com/${repoName}/releases/download/${tag}/${apkName}`;

const summaryLines = [
  'Android release complete!',
  `  Version: ${version} (versionCode ${versionCode})`,
  `  APK: ${apkUrl}`,
];
if (existsSync(keyPath)) {
  summaryLines.push('  Google Play: AAB uploaded (internal track)');
}
await writeSummary('android', summaryLines);
