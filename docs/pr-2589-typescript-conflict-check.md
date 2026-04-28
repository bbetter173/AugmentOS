# PR 2589 TypeScript Conflict Check

This document records a local merge simulation between the Bluetooth SDK feature branch and PR #2589, "Island", so we can judge whether our TypeScript changes will cause too many conflicts.

## Inputs

- Ours: `philippe/os-1178-mentra-bluetooth-sdk-feature` at `67af08ebf`, plus the local deletion of `mobile/src/services/modelDownloadService.ts`
- Theirs: `origin/pr/2589` at `a637e4071`
- Merge base: `e8313e4db`
- PR: https://github.com/Mentra-Community/MentraOS/pull/2589
- Command: delete `mobile/src/services/modelDownloadService.ts` in the temporary worktree, then run `git merge --no-commit --no-ff origin/pr/2589`
- Safety: the command was run in `/tmp/mentraos-pr2589-conflict-check`, a temporary worktree detached from this checkout.

## Result

The conflict surface is smaller than the total diff makes it look. The bulk TypeScript rename work does not create many same-file conflicts with PR #2589.

Hard conflict paths from the actual merge attempt:

- `mobile/bun.lock`
- `mobile/metro.config.js`
- `mobile/modules/bluetooth-sdk/bun.lock`
- `mobile/modules/island/src/services/WebviewBridge.ts`
- `mobile/package.json`
- `mobile/scripts/postinstall.mjs`
- `mobile/src/effects/Compositor.tsx`

Direct TypeScript conflict paths:

- `mobile/modules/island/src/services/WebviewBridge.ts`
- `mobile/src/effects/Compositor.tsx`

TypeScript paths changed by both branches but auto-merged by Git:

- `mobile/src/services/MantleManager.ts`
- `mobile/src/stores/applets.ts`
- `mobile/src/utils/PermissionsUtils.tsx`

## Recommended Resolution

- For `Compositor.tsx`, prefer PR #2589's deletion of the old commented STT/mic PCM experiment. That avoids a Bluetooth SDK import in a file PR #2589 is already simplifying.
- For `WebviewBridge.ts`, transplant the Bluetooth SDK import/command compatibility from our old `MiniComms.ts` changes into the new Island file. This keeps `bluetooth_sdk_fn` while preserving the legacy `core_fn` alias.
- For `modelDownloadService.ts`, keep the local deletion. It only referenced missing modules and had no call sites outside itself, so deleting it avoids lint suppressions and lines up with PR #2589's deletion.
- For `package.json`, `bun.lock`, `metro.config.js`, and `postinstall.mjs`, combine the module layout rather than choosing one side blindly: keep the renamed Bluetooth SDK module and keep Island's new workspace/module wiring.
- For `MantleManager.ts`, do a semantic review after the merge even though Git auto-merges it. This is the riskiest file because both branches touch app/bootstrap behavior.

## Raw Merge Output

```text
Auto-merging mobile/bun.lock
CONFLICT (content): Merge conflict in mobile/bun.lock
Auto-merging mobile/metro.config.js
CONFLICT (content): Merge conflict in mobile/metro.config.js
CONFLICT (rename/delete): mobile/modules/core/bun.lock renamed to mobile/modules/bluetooth-sdk/bun.lock in HEAD, but deleted in origin/pr/2589.
CONFLICT (modify/delete): mobile/modules/bluetooth-sdk/bun.lock deleted in origin/pr/2589 and modified in HEAD.  Version HEAD of mobile/modules/bluetooth-sdk/bun.lock left in tree.
Auto-merging mobile/modules/island/src/services/WebviewBridge.ts
CONFLICT (content): Merge conflict in mobile/modules/island/src/services/WebviewBridge.ts
Auto-merging mobile/package.json
CONFLICT (content): Merge conflict in mobile/package.json
Auto-merging mobile/scripts/postinstall.mjs
CONFLICT (content): Merge conflict in mobile/scripts/postinstall.mjs
Auto-merging mobile/src/effects/Compositor.tsx
CONFLICT (content): Merge conflict in mobile/src/effects/Compositor.tsx
Auto-merging mobile/src/services/MantleManager.ts
Auto-merging mobile/src/stores/applets.ts
Auto-merging mobile/src/utils/PermissionsUtils.tsx
Automatic merge failed; fix conflicts and then commit the result.
```

## Index Stages

This is the unmerged index after the merge attempt. Stage 1 is merge base, stage 2 is ours, and stage 3 is theirs.

```text
100644 ed6fa80555e058b0dc15389ac1160fdda6cbc1c6 1	mobile/bun.lock
100644 3ce3d8f96c0500f8259669cc98549e93ca9fb75e 2	mobile/bun.lock
100644 de2834026fa09de74426dfb4a01e6a4ab52701c0 3	mobile/bun.lock
100644 df340cfe97229b9fc3e2305b5cd68331e322e25a 1	mobile/metro.config.js
100644 f4fb49e5a2df5d2ba790ac19db509014545dd707 2	mobile/metro.config.js
100644 cecc40e8e3cb84998cbda95b58c660a2f97508cc 3	mobile/metro.config.js
100644 70101458cfd3fcfc5517d60d3cd5dd56cfc1283e 1	mobile/modules/bluetooth-sdk/bun.lock
100644 d495621c5aea34c080d7e2a9ad42d739e0ff5b70 2	mobile/modules/bluetooth-sdk/bun.lock
100644 7ebe1aa888467f3463216055888ee510336e5bf6 1	mobile/modules/island/src/services/WebviewBridge.ts
100644 cac18bb6914359bc95e7096996ff6377596c33b0 2	mobile/modules/island/src/services/WebviewBridge.ts
100644 658887104a627a0db98d48eb4b88e95d52576a42 3	mobile/modules/island/src/services/WebviewBridge.ts
100644 ee8123af697193b0255048e687de03b94acceaf7 1	mobile/package.json
100644 5624b6d17b017b10455347642fb491f1262a8731 2	mobile/package.json
100644 a5e499a1dc69ac2d66496bd5d938c0c5ccdb413b 3	mobile/package.json
100755 0ba8601d9d40150d741bf4739034634ade368c4a 1	mobile/scripts/postinstall.mjs
100755 62614dbb69f9ff60723ab8193fdc5806c9e5189a 2	mobile/scripts/postinstall.mjs
100755 d889ff6214a207021a63f681126508fefead55b7 3	mobile/scripts/postinstall.mjs
100644 6b9df6b6cf0bb8165c598d241128e3fd71bdde22 1	mobile/src/effects/Compositor.tsx
100644 42558c4bdfc06157c7de255b03bff2be66c8ff8e 2	mobile/src/effects/Compositor.tsx
100644 806389bb3f4c58763978fe2761590f352ec98c6a 3	mobile/src/effects/Compositor.tsx
```

## Actual Three-Way Diff

The following is the combined diff from the conflicted temporary worktree. In conflict markers, `HEAD` is our branch, the `||||||| e8313e4db` section is the merge base, and `origin/pr/2589` is the Island PR.

```diff
diff --cc mobile/bun.lock
index 3ce3d8f96,de2834026..000000000
--- a/mobile/bun.lock
+++ b/mobile/bun.lock
@@@ -29,7 -28,8 +29,15 @@@
          "authing-js-sdk": "^4.23.55",
          "axios": "^1.13.6",
          "babel-plugin-module-resolver": "5.0.0",
++<<<<<<< HEAD
 +        "crust": "file:./modules/crust",
++||||||| e8313e4db
++        "core": "file:./modules/core",
++        "crust": "file:./modules/crust",
++=======
+         "core": "workspace:*",
+         "crust": "workspace:*",
++>>>>>>> origin/pr/2589
          "date-fns": "^4.1.0",
          "dotenv": "^17.3.1",
          "expo": "^55.0.5",
@@@ -720,16 -769,14 +777,16 @@@

      "@livekit/mutex": ["@livekit/mutex@1.1.1", "", {}, "sha512-EsshAucklmpuUAfkABPxJNhzj9v2sG7JuzFDL4ML1oJQSV14sqrpTYnsaOudMAw9yOaW53NU3QQTlUQoRs4czw=="],

-     "@livekit/protocol": ["@livekit/protocol@1.44.0", "", { "dependencies": { "@bufbuild/protobuf": "^1.10.0" } }, "sha512-/vfhDUGcUKO8Q43r6i+5FrDhl5oZjm/X3U4x2Iciqvgn5C8qbj+57YPcWSJ1kyIZm5Cm6AV2nAPjMm3ETD/iyg=="],
+     "@livekit/protocol": ["@livekit/protocol@1.45.3", "", { "dependencies": { "@bufbuild/protobuf": "^1.10.0" } }, "sha512-WmMxBTsy4dRBqcrswFwUUlgq3Z0nnhOqKR6tX749Rb/PcB1yBMUtrHxZvcsS6qi3/5+86zHeVG+exmu1sZqfJg=="],

-     "@livekit/react-native": ["@livekit/react-native@2.9.6", "", { "dependencies": { "@livekit/components-react": "^2.9.17", "@livekit/mutex": "^1.1.1", "array.prototype.at": "^1.1.1", "base64-js": "1.5.1", "event-target-shim": "6.0.2", "events": "^3.3.0", "loglevel": "^1.8.0", "promise.allsettled": "^1.0.5", "react-native-url-polyfill": "^1.3.0", "typed-emitter": "^2.1.0", "web-streams-polyfill": "^4.1.0", "well-known-symbols": "^4.1.0" }, "peerDependencies": { "@livekit/react-native-webrtc": "^137.0.2", "livekit-client": "^2.15.8", "react": "*", "react-native": "*" } }, "sha512-4DOFJ/OO4yftZbm90QnVMDjwFXqSw2hcruSVO2idgwFxylDmH6NN2e1rs5ZCQPsnqlfwuMGz8vNfuYt++G4C/A=="],
+     "@livekit/react-native": ["@livekit/react-native@2.10.1", "", { "dependencies": { "@livekit/components-react": "^2.9.17", "@livekit/mutex": "^1.1.1", "array.prototype.at": "^1.1.1", "base64-js": "1.5.1", "events": "^3.3.0", "loglevel": "^1.8.0", "promise.allsettled": "^1.0.5", "react-native-url-polyfill": "^1.3.0", "typed-emitter": "^2.1.0", "web-streams-polyfill": "^4.1.0", "well-known-symbols": "^4.1.0" }, "peerDependencies": { "@livekit/react-native-webrtc": "^144.0.0", "livekit-client": "^2.15.8", "react": "*", "react-native": "*" } }, "sha512-HQYqosgcaHif8vBRZweoJ2nzzx7G3IBNnaKQDX9+b1eJmjEl+A1bhwqfRO9ZeV/ZkY3djX6TXjIRs33bmLNCRA=="],

-     "@livekit/react-native-expo-plugin": ["@livekit/react-native-expo-plugin@1.0.1", "", { "peerDependencies": { "@livekit/react-native": "^2.1.0", "expo": "*", "react": "*", "react-native": "*" } }, "sha512-CSPjjzgDDlBH1ZyFyaw7/FW2Ql1S51eUkIxv/vjGwVshn+lUD6eQ9VgfUh7ha84itvjXi9X87FvP0XWKn9CiFQ=="],
+     "@livekit/react-native-expo-plugin": ["@livekit/react-native-expo-plugin@1.0.2", "", { "peerDependencies": { "@livekit/react-native": "^2.1.0", "expo": "*", "react": "*", "react-native": "*" } }, "sha512-Crnht6xAlvbSo677oXFBMzS6I5lCMfCNNyLIs6bQZOwlwempz6tWj4CddRknqCCd/dvAyHCa1HwslqXpvGoSJA=="],

-     "@livekit/react-native-webrtc": ["@livekit/react-native-webrtc@137.0.2", "", { "dependencies": { "base64-js": "1.5.1", "debug": "4.3.4", "event-target-shim": "6.0.2" }, "peerDependencies": { "react-native": ">=0.60.0" } }, "sha512-0aXYATcBraOMDTteKzmfH5ICNHw8xFyMPHmhKg14+94fAGZ2hGjdHZUSkzL14+e508W486aIAmbXipuSQCCJgA=="],
+     "@livekit/react-native-webrtc": ["@livekit/react-native-webrtc@137.0.3", "", { "dependencies": { "base64-js": "1.5.1", "debug": "4.3.4" }, "peerDependencies": { "react-native": ">=0.60.0" } }, "sha512-vfg2w/lMLNIRsIkRO0HWo6aTzkpCiBsgtHuvuIf3QF2pMgCK1w206nmrb4ATlv7v0Xu8e+/q/22gBRdsyIV4Aw=="],

 +    "@mentra/bluetooth-sdk": ["@mentra/bluetooth-sdk@file:modules/bluetooth-sdk", { "devDependencies": { "expo-module-scripts": "^55.0.2" }, "peerDependencies": { "@expo/config-plugins": "*", "@types/react": "*", "expo": "*", "react": "*", "react-native": "*" } }],
 +
      "@mentra/display-utils": ["@mentra/display-utils@file:../cloud/packages/display-utils", { "devDependencies": { "opentype.js": "^1.3.4", "typescript": "^5.0.0" } }],

      "@nicolo-ribaudo/chokidar-2": ["@nicolo-ribaudo/chokidar-2@2.1.8-no-fsevents.3", "", {}, "sha512-s88O1aVtXftvp5bCPB7WnmXc5IwOZZ7YPuwNPt+GtOOXpPvad1LfbmjYv+qII7zP6RU2QGnqve27dnLycEnyEQ=="],
@@@ -1304,11 -1289,11 +1299,19 @@@

     "connect": ["connect@3.7.0", "", { "dependencies": { "debug": "2.6.9", "finalhandler": "1.1.2", "parseurl": "~1.3.3", "utils-merge": "1.0.1" } }, "sha512-ZqRXc+tZukToSNmh5C2iWMSoV3X1YUcPbqEM4DkEG5tNQXrQUZCNVGGv3IuicnkMtPfGf3Xtp8WCXs295iQ1pQ=="],

-     "content-type": ["content-type@1.0.5", "", {}, "sha512-nTjqfcBFEipKdXCv4YDQWCfmcLZKm81ldF0pAopTvyrFGVbcR6P/VAAd5G7N+0tTr8QqiU0tFadD6FK4NtJwOA=="],
-
      "convert-source-map": ["convert-source-map@2.0.0", "", {}, "sha512-Kvp459HrV2FEJ1CAsi1Ku+MY3kasH19TFykTz2xWmMeq6bk2NU3XXvfJ+Q61m0xktWwt+1HSYf3JZsTms3aRJg=="],

++<<<<<<< HEAD
++    "core-js-compat": ["core-js-compat@3.48.0", "", { "dependencies": { "browserslist": "^4.28.1" } }, "sha512-OM4cAF3D6VtH/WkLtWvyNC56EZVXsZdU3iqaMG2B4WvYrlqU831pc4UtG5yp0sE9z8Y02wVN7PjW5Zf9Gt0f1Q=="],
++||||||| e8313e4db
++    "core": ["core@file:modules/core", { "devDependencies": { "expo-module-scripts": "^55.0.2" }, "peerDependencies": { "@expo/config-plugins": "*", "@types/react": "*", "expo": "*", "react": "*", "react-native": "*" } }],
++
 +    "core-js-compat": ["core-js-compat@3.48.0", "", { "dependencies": { "browserslist": "^4.28.1" } }, "sha512-OM4cAF3D6VtH/WkLtWvyNC56EZVXsZdU3iqaMG2B4WvYrlqU831pc4UtG5yp0sE9z8Y02wVN7PjW5Zf9Gt0f1Q=="],
++=======
+     "core": ["core@workspace:modules/core"],
+
+     "core-js-compat": ["core-js-compat@3.49.0", "", { "dependencies": { "browserslist": "^4.28.1" } }, "sha512-VQXt1jr9cBz03b331DFDCCP90b3fanciLkgiOoy8SBHy06gNf+vQ1A3WFLqG7I8TipYIKeYK9wxd0tUrvHcOZA=="],
++>>>>>>> origin/pr/2589

      "cosmiconfig": ["cosmiconfig@8.3.6", "", { "dependencies": { "import-fresh": "^3.3.0", "js-yaml": "^4.1.0", "parse-json": "^5.2.0", "path-type": "^4.0.0" }, "peerDependencies": { "typescript": ">=4.9.5" }, "optionalPeers": ["typescript"] }, "sha512-kcZ6+W5QzcJ3P1Mt+83OUv/oHFqZHIx8DuxG6eZ5RGMERoLqp4BuGjhHLYGK+Kf5XVkQvqBSmAy/nGWN3qDgEA=="],

diff --cc mobile/metro.config.js
index f4fb49e5a,cecc40e8e..000000000
--- a/mobile/metro.config.js
+++ b/mobile/metro.config.js
@@@ -31,7 -31,8 +31,14 @@@ config.resolver.assetExts = [...config.

  // Watch the core and cloud modules for changes
  config.watchFolders = [
++<<<<<<< HEAD
 +  path.resolve(__dirname, "./modules/bluetooth-sdk"),
++||||||| e8313e4db
++  path.resolve(__dirname, "./modules/core"),
++=======
+   path.resolve(__dirname, "./modules/core"),
+   path.resolve(__dirname, "./modules/island"),
++>>>>>>> origin/pr/2589
    path.resolve(__dirname, "../cloud/packages/types/src"),
    path.resolve(__dirname, "../cloud/packages/display-utils/src"),
  ]
diff --cc mobile/modules/island/src/services/WebviewBridge.ts
index cac18bb69,658887104..000000000
--- a/mobile/modules/island/src/services/WebviewBridge.ts
+++ b/mobile/modules/island/src/services/WebviewBridge.ts
@@@ -214,9 -213,9 +214,19 @@@ class WebviewBridge
      }
    }

++<<<<<<< HEAD:mobile/src/services/MiniComms.ts
 +  private handleRequestTranscription(_packageName: string, _message: MiniAppMessage) {
 +    // composer
 +  }
++||||||| e8313e4db:mobile/src/services/MiniComms.ts
++  private handleRequestTranscription(packageName: string, message: MiniAppMessage) {
++    // composer
++  }
++=======
+   // private handleRequestTranscription(packageName: string, message: MiniAppMessage) {
+   //   // composer
+   // }
++>>>>>>> origin/pr/2589:mobile/modules/island/src/services/WebviewBridge.ts

    private sendResponse(packageName: string, requestId: string | undefined, result: any) {
      if (!requestId) return
diff --cc mobile/package.json
index 5624b6d17,a5e499a1d..000000000
--- a/mobile/package.json
+++ b/mobile/package.json
@@@ -58,7 -60,8 +61,15 @@@
      "authing-js-sdk": "^4.23.55",
      "axios": "^1.13.6",
      "babel-plugin-module-resolver": "5.0.0",
++<<<<<<< HEAD
 +    "crust": "file:./modules/crust",
++||||||| e8313e4db
++    "core": "file:./modules/core",
++    "crust": "file:./modules/crust",
++=======
+     "core": "workspace:*",
+     "crust": "workspace:*",
++>>>>>>> origin/pr/2589
      "date-fns": "^4.1.0",
      "dotenv": "^17.3.1",
      "expo": "^55.0.5",
diff --cc mobile/scripts/postinstall.mjs
index 62614dbb6,d889ff621..000000000
--- a/mobile/scripts/postinstall.mjs
+++ b/mobile/scripts/postinstall.mjs
@@@ -5,18 -5,20 +5,34 @@@ console.log('Running postinstall...')
  // Patch packages (--error-on-fail to allow version mismatches - patches are iOS-only anyway)
  await $({ stdio: 'inherit', nothrow: true })`patch-package`;

++<<<<<<< HEAD
 +console.log('Building Bluetooth SDK module...');
 +// Install Bluetooth SDK module dependencies first (needed for expo-module CLI)
 +await $({ stdio: 'inherit', cwd: 'modules/bluetooth-sdk' })`bun install --ignore-scripts`;
 +// Now run prepare (expo-module will be available in node_modules/.bin)
 +await $({ stdio: 'inherit', cwd: 'modules/bluetooth-sdk' })`bun run prepare`;
++||||||| e8313e4db
++console.log('Building core module...');
++// Install core module dependencies first (needed for expo-module CLI)
++await $({ stdio: 'inherit', cwd: 'modules/core' })`bun install --ignore-scripts`;
++// Now run prepare (expo-module will be available in node_modules/.bin)
++await $({ stdio: 'inherit', cwd: 'modules/core' })`bun run prepare`;
++=======
+ console.log('Building core module...');
+ // Workspace setup hoists deps to root node_modules — per-module `bun install`
+ // is no longer needed and re-introduced duplicate react/react-native copies.
+ // Kept commented for reference in case we need to revert.
+ // await $({ stdio: 'inherit', cwd: 'modules/core' })`bun install --ignore-scripts`;
+ await $({ stdio: 'inherit', cwd: 'modules/core' })`bun run prepare`;
++>>>>>>> origin/pr/2589

- // install crust module dependencies
- await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun install --ignore-scripts`;
- // now run prepare (expo-module will be available in node_modules/.bin)
+ // await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun install --ignore-scripts`;
  await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun run prepare`;

+ // await $({ stdio: 'inherit', cwd: 'modules/island' })`bun install --ignore-scripts`;
+ await $({ stdio: 'inherit', cwd: 'modules/island' })`bun run prepare`;
+
  // ignore scripts to avoid infinite loop:
- await $({ stdio: 'inherit' })`bun install --ignore-scripts`;
+ // await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

  console.log('✅ Postinstall completed successfully!');
diff --cc mobile/src/effects/Compositor.tsx
index 42558c4bd,806389bb3..000000000
--- a/mobile/src/effects/Compositor.tsx
+++ b/mobile/src/effects/Compositor.tsx
@@@ -1,15 -1,11 +1,21 @@@
  import {memo, useEffect, useMemo, useRef, useState} from "react"
  import {View} from "react-native"
- import {useLocalMiniApps} from "@/stores/applets"
+ import {appStore, appRegistry} from "island"
  import LocalMiniApp from "@/components/home/LocalMiniApp"
- import composer from "@/services/Composer"
  import {usePathname} from "expo-router"
 -import {Screen, Text} from "@/components/ignite"
 +import {Screen} from "@/components/ignite"
  import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
  import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
++<<<<<<< HEAD
 +import CoreModule, {MicPcmEvent} from "@mentra/bluetooth-sdk"
 +import {SETTINGS, useSetting} from "@/stores/settings"
 +// import {useCactusSTT} from "cactus-react-native"
++||||||| e8313e4db
++import CoreModule, {MicPcmEvent} from "core"
++import {SETTINGS, useSetting} from "@/stores/settings"
++// import {useCactusSTT} from "cactus-react-native"
++=======
++>>>>>>> origin/pr/2589

  const LmaContainer = memo(
    function LmaContainer({
@@@ -59,10 -55,6 +65,16 @@@ function Compositor()
    const viewShotRef = useRef<View>(null)
    const [packageName, setPackageName] = useState<string | null>(null)
    const {getCurrentParams} = useNavigationHistory()
++<<<<<<< HEAD
 +  const [offlineCaptionsRunning, _setOfflineCaptionsRunning] = useSetting(SETTINGS.offline_captions_running.key)
 +  const [offlineTranslationRunning, _setOfflineTranslationRunning] = useSetting(
 +    SETTINGS.offline_translation_running.key,
 +  )
++||||||| e8313e4db
++  const [offlineCaptionsRunning, setOfflineCaptionsRunning] = useSetting(SETTINGS.offline_captions_running.key)
++  const [offlineTranslationRunning, setOfflineTranslationRunning] = useSetting(SETTINGS.offline_translation_running.key)
++=======
++>>>>>>> origin/pr/2589

    useEffect(() => {
      if (pathname.includes("/applet/local")) {
@@@ -104,93 -96,6 +116,184 @@@

    // console.log("COMPOSITOR: Resolved Lmas", resolvedLmas.map((lma) => lma.packageName + " " + lma.running))

++<<<<<<< HEAD
 +  // const model = useSpeechToText({
 +  //   model: WHISPER_TINY_EN,
 +  // })
 +
 +  // const cactusSTT = useCactusSTT({
 +  //   model: "whisper-medium",
 +  //   options: {
 +  //     pro: true,
 +  //     // quantization: "int8",
 +  //   },
 +  // })
 +
 +  const _transcription = useRef<string>("")
 +  const _useExecutorch = false
 +  const _useCactus = false
 +  const _useExpoSpeech = true
 +
 +  const handlePcm = async (_pcm: ArrayBuffer) => {
 +    // if (useExpoSpeech) {
 +    //   const audioChunk = decodePcm16ToFloat32(pcm)
 +    //   SpeechTranscriber.realtimeBufferTranscribe(
 +    //     audioChunk, // Float32Array or number[]
 +    //     16000, // sample rate
 +    //   )
 +    //   return
 +    // }
 +    // if (useExecutorch) {
 +    //   // const audioChunk = new Float32Array(pcm)
 +    //   const audioChunk = decodePcm16ToFloat32(pcm)
 +    //   sttModule.streamInsert(audioChunk)
 +    //   return
 +    // }
 +    // const audioChunk = Array.from(new Int16Array(pcm))
 +    // // const audioChunk = decodePcm16ToFloat32(pcm)
 +    // // const audioChunk = Array.from(new Float32Array(pcm))
 +    // const result = await cactusSTT.streamTranscribeProcess({audio: audioChunk})
 +    // if (result.confirmed) {
 +    //   // console.log("COMPOSITOR: c:", result.confirmed)
 +    //   transcription.current += " " + result.confirmed
 +    //   // if (result.confirmed.length > 100) {
 +    //   //   transcription.current = transcription.current.slice(-100)
 +    //   // }
 +    // }
 +    // if (result.pending) {
 +    //   console.log("COMP: P:", result.pending)
 +    // }
 +    // console.log("COMP: F:", transcription.current)
 +  }
 +
 +  useEffect(() => {
 +    const initSTT = async () => {
 +      // await CoreModule.update("core", {
 +      //   should_send_pcm: true,
 +      // })
 +
 +      // await cactusSTT.download({
 +      //   onProgress: (progress: number) => {
 +      //     console.log("COMPOSITOR: Downloading cactus model...", progress)
 +      //   },
 +      // })
 +
 +      // await cactusSTT.streamTranscribeStart({
 +      //   confirmationThreshold: 0.99,
 +      //   minChunkSize: 32000,
 +      // })
 +
 +      const pcmSub = CoreModule.addListener("mic_pcm", (event: MicPcmEvent) => {
 +        // console.log("COMPOSITOR: Received mic pcm:", event.base64)
 +        // const samples = decodePcm16Base64ToFloat32(event.base64)
 +        // sttModule.streamInsert(samples)
 +        handlePcm(event.pcm)
 +      })
 +
 +      return () => {
 +        pcmSub?.remove()
 +      }
 +    }
 +    initSTT()
 +  }, [])
 +
 +  useEffect(() => {
 +    // cactusSTT.start()
 +    return () => {
 +      // cactusSTT.stop()
 +    }
 +  }, [offlineCaptionsRunning, offlineTranslationRunning])
 +
++||||||| e8313e4db
++  // const model = useSpeechToText({
++  //   model: WHISPER_TINY_EN,
++  // })
++
++  // const cactusSTT = useCactusSTT({
++  //   model: "whisper-medium",
++  //   options: {
++  //     pro: true,
++  //     // quantization: "int8",
++  //   },
++  // })
++
++  const transcription = useRef<string>("")
++  let useExecutorch = false
++  let useCactus = false
++  let useExpoSpeech = true
++
++  const handlePcm = async (pcm: ArrayBuffer) => {
++    // if (useExpoSpeech) {
++    //   const audioChunk = decodePcm16ToFloat32(pcm)
++    //   SpeechTranscriber.realtimeBufferTranscribe(
++    //     audioChunk, // Float32Array or number[]
++    //     16000, // sample rate
++    //   )
++    //   return
++    // }
++    // if (useExecutorch) {
++    //   // const audioChunk = new Float32Array(pcm)
++    //   const audioChunk = decodePcm16ToFloat32(pcm)
++    //   sttModule.streamInsert(audioChunk)
++    //   return
++    // }
++    // const audioChunk = Array.from(new Int16Array(pcm))
++    // // const audioChunk = decodePcm16ToFloat32(pcm)
++    // // const audioChunk = Array.from(new Float32Array(pcm))
++    // const result = await cactusSTT.streamTranscribeProcess({audio: audioChunk})
++    // if (result.confirmed) {
++    //   // console.log("COMPOSITOR: c:", result.confirmed)
++    //   transcription.current += " " + result.confirmed
++    //   // if (result.confirmed.length > 100) {
++    //   //   transcription.current = transcription.current.slice(-100)
++    //   // }
++    // }
++    // if (result.pending) {
++    //   console.log("COMP: P:", result.pending)
++    // }
++    // console.log("COMP: F:", transcription.current)
++  }
++
++  useEffect(() => {
++    const initSTT = async () => {
++      // await CoreModule.update("core", {
++      //   should_send_pcm: true,
++      // })
++
++      // await cactusSTT.download({
++      //   onProgress: (progress: number) => {
++      //     console.log("COMPOSITOR: Downloading cactus model...", progress)
++      //   },
++      // })
++
++      // await cactusSTT.streamTranscribeStart({
++      //   confirmationThreshold: 0.99,
++      //   minChunkSize: 32000,
++      // })
++
++      const pcmSub = CoreModule.addListener("mic_pcm", (event: MicPcmEvent) => {
++        // console.log("COMPOSITOR: Received mic pcm:", event.base64)
++        // const samples = decodePcm16Base64ToFloat32(event.base64)
++        // sttModule.streamInsert(samples)
++        handlePcm(event.pcm)
++      })
++
++      return () => {
++        pcmSub?.remove()
++      }
++    }
++    initSTT()
++  }, [])
++
++  useEffect(() => {
++    // cactusSTT.start()
++    return () => {
++      // cactusSTT.stop()
++    }
++  }, [offlineCaptionsRunning, offlineTranslationRunning])
++
++=======
++>>>>>>> origin/pr/2589
    return (
      <View className={`absolute inset-0 ${isActive ? "z-11" : "z-0"}`} pointerEvents="box-none">
        <View className="z-12">
* Unmerged path mobile/modules/bluetooth-sdk/bun.lock
```

## Remaining Modify/Delete Detail

`mobile/modules/bluetooth-sdk/bun.lock` is a rename/delete plus modify/delete conflict. Our branch renamed the module from `core` to `@mentra/bluetooth-sdk`; PR #2589 deletes the old module lockfile in favor of workspace dependency behavior.

```diff
* Unmerged path mobile/modules/bluetooth-sdk/bun.lock
diff --git a/mobile/modules/bluetooth-sdk/bun.lock b/mobile/modules/bluetooth-sdk/bun.lock
index 70101458c..d495621c5 100644
--- a/mobile/modules/bluetooth-sdk/bun.lock
+++ b/mobile/modules/bluetooth-sdk/bun.lock
@@ -3,16 +3,16 @@
   "configVersion": 1,
   "workspaces": {
     "": {
-      "name": "core",
+      "name": "@mentra/bluetooth-sdk",
       "devDependencies": {
         "expo-module-scripts": "^55.0.2",
       },
       "peerDependencies": {
-        "@expo/config-plugins": "*",
-        "@types/react": "*",
-        "expo": "*",
-        "react": "*",
-        "react-native": "*",
+        "@expo/config-plugins": ">=8.0.0",
+        "@types/react": ">=18.0.0",
+        "expo": ">=49.0.0",
+        "react": ">=18.0.0",
+        "react-native": ">=0.72.0",
       },
     },
   },
```
