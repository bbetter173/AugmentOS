#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
import { withRetry, isSentryTransientError, writeSummary } from './release-utils.mjs';
import { getBuildNumber } from './build-number.mjs';
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

function ipaPrefix(version) {
  const { major, minor } = parseVersion(version);
  return `Mentra_iOS_${major}p${minor}`;
}

// ── Load App Store Connect credentials ────────────────────────────────────────

function loadASCConfig() {
  const configPath = path.join(os.homedir(), '.mentra', 'credentials', 'appstore-connect.env');
  if (!existsSync(configPath)) {
    return null;
  }
  const content = require('fs').readFileSync(configPath, 'utf-8');
  const config = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      config[match[1]] = match[2].replace(/^~/, os.homedir());
    }
  }
  return config;
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
const prefix = ipaPrefix(version);
console.log(`Version: ${version} → tag: ${tag}, prefix: ${prefix}`);

// ── Step 2: Derive build number ──────────────────────────────────────────────

// Pin the value via env var so every getBuildNumber() call in this process
// tree (including app.config.ts evaluations during prebuild + Xcode's later
// reads) returns the same number. Without pinning, the summary value can
// drift from the value baked into the IPA by a few seconds.
const buildNumber = getBuildNumber();
process.env.MENTRAOS_PINNED_BUILD_NUMBER = String(buildNumber);
console.log(`buildNumber: ${buildNumber}`);

// ── Step 3: Prebuild iOS ──────────────────────────────────────────────────────

console.log('\n━━━ Step 3: Prebuild iOS ━━━');
await $({ stdio: 'inherit' })`bun expo prebuild --platform ios`;

// Copy .env to ios/.xcode.env.local so build env vars are available
await $({ stdio: 'inherit' })`cp .env ios/.xcode.env.local`;

// ── Step 4: Archive ───────────────────────────────────────────────────────────

console.log('\n━━━ Step 4: Archiving ━━━');

const teamId = process.env.APPLE_TEAM_ID;
if (!teamId) {
  console.error('APPLE_TEAM_ID not found in .env — add it to your .env file');
  process.exit(1);
}

const archivePath = path.resolve('build/Mentra.xcarchive');

// stdio:'pipe' so withRetry's predicate can inspect output for transient
// Sentry/network errors; we still pipe to the terminal so progress is visible.
await withRetry(
  'xcodebuild archive',
  () => {
    const p = $`xcodebuild archive -workspace ios/Mentra.xcworkspace -scheme Mentra -configuration Release -destination generic/platform=iOS -archivePath ${archivePath} DEVELOPMENT_TEAM=${teamId} SWIFT_STRICT_CONCURRENCY=minimal`;
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    return p;
  },
  { shouldRetry: isSentryTransientError }
);

if (!existsSync(archivePath)) {
  console.error('Archive not found at:', archivePath);
  process.exit(1);
}
console.log('Archive created successfully');

// ── Step 5: Export IPA ────────────────────────────────────────────────────────

console.log('\n━━━ Step 5: Exporting IPA ━━━');

const exportPath = path.resolve('build/ios-export');
// Clean previous export to avoid picking up stale IPAs
await $`rm -rf ${exportPath}`;
const exportOptionsPlist = path.resolve('ci/ios-export/ExportOptions.plist');

await $({ stdio: 'inherit' })`xcodebuild -exportArchive -archivePath ${archivePath} -exportOptionsPlist ${exportOptionsPlist} -exportPath ${exportPath} -allowProvisioningUpdates`;

// Find the exported IPA
const ipaFiles = (await $`ls ${exportPath}/*.ipa`).stdout.trim().split('\n').filter(Boolean);
if (ipaFiles.length === 0) {
  console.error('No IPA found in export path:', exportPath);
  process.exit(1);
}
const ipaPath = ipaFiles[0];
console.log('IPA exported:', ipaPath);

// ── Step 6: Upload to App Store Connect (TestFlight) ──────────────────────────

console.log('\n━━━ Step 6: Uploading to App Store Connect ━━━');

const ascConfig = loadASCConfig();

if (!ascConfig || !ascConfig.ASC_API_KEY_ID || !ascConfig.ASC_API_ISSUER_ID || !existsSync(ascConfig.ASC_API_KEY_PATH || '')) {
  console.log('⚠️  App Store Connect credentials not found at ~/.mentra/credentials/appstore-connect.env');
  console.log('   Skipping TestFlight upload.');
  console.log('   To enable: create ~/.mentra/credentials/appstore-connect.env with ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_PATH');
} else {
  // altool looks for AuthKey_<id>.p8 in $API_PRIVATE_KEYS_DIR
  const keyDir = path.dirname(ascConfig.ASC_API_KEY_PATH);
  await withRetry('altool TestFlight upload', () =>
    $({ stdio: 'inherit', env: { ...process.env, API_PRIVATE_KEYS_DIR: keyDir } })`xcrun altool --upload-app -f ${ipaPath} -t ios --apiKey ${ascConfig.ASC_API_KEY_ID} --apiIssuer ${ascConfig.ASC_API_ISSUER_ID}`
  );
  console.log('IPA uploaded to App Store Connect (TestFlight)');
}

// ── Step 7: Upload IPA to GitHub release ──────────────────────────────────────

console.log('\n━━━ Step 7: Uploading IPA to GitHub release ━━━');

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
    // Find the latest APK beta number and use the same number for iOS
    const apkBetas = assets
      .map(a => a.name)
      .filter(name => name.endsWith('.apk'))
      .map(name => {
        const match = name.match(/_Beta_(\d+)\.apk$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);
    if (apkBetas.length > 0) {
      betaNumber = Math.max(...apkBetas);
    }
  }
} catch {
  releaseExists = false;
}

const ipaName = `${prefix}_Beta_${betaNumber}.ipa`;
const renamedIpaPath = path.resolve('build/ios-export', ipaName);
await $`mv ${ipaPath} ${renamedIpaPath}`;
console.log(`IPA renamed to: ${ipaName} (Beta ${betaNumber})`);

if (!releaseExists) {
  console.log(`Creating new pre-release: ${tag}`);
  await withRetry('gh release create', () =>
    $({ stdio: 'inherit' })`gh release create ${tag} --prerelease --title ${tag} --notes ${'Pre-release ' + tag}`
  );
}

await withRetry('gh release upload (IPA)', () =>
  $({ stdio: 'inherit' })`gh release upload ${tag} ${renamedIpaPath} --clobber`
);
console.log(`Uploaded ${ipaName} to release ${tag}`);

// ── Done ──────────────────────────────────────────────────────────────────────

const repoName = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`).stdout.trim();
const ipaUrl = `https://github.com/${repoName}/releases/download/${tag}/${ipaName}`;

const summaryLines = [
  'iOS release complete!',
  `  Version: ${version} (buildNumber ${buildNumber})`,
  `  IPA: ${ipaUrl}`,
];
if (ascConfig && existsSync(ascConfig.ASC_API_KEY_PATH || '')) {
  summaryLines.push('  TestFlight: uploaded');
}
await writeSummary('ios', summaryLines);
