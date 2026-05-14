# Type Check Behavior Notes

These are TypeScript errors that look like they may reflect runtime or product behavior problems. The compile fixes were kept narrow and mostly type-only, so these items were not behaviorally changed here.

## OTA Wi-Fi state

- `src/app/ota/check-for-updates.tsx` reads `useGlassesStore(...).wifiConnected`, but `src/stores/glasses.ts` normalizes Wi-Fi into `state.wifi.state` and does not persist the legacy `wifiConnected` field. I made the legacy field optional in the store type so the current code compiles without changing behavior. The screen may treat glasses as not connected to Wi-Fi even when `state.wifi.state === "connected"`.

## App settings update error handling

- `src/app/applet/settings.tsx` previously treated `restComms.updateAppSetting(...)` as a catchable Promise, but `RestComms.updateAppSetting` returns `AsyncResult<void, Error>`. The PR now handles the resolved `Result` directly. If setting-update errors were previously expected to reject through `.catch(...)`, that expectation was wrong for the current `typesafe-ts` API.

## Local MiniSockets

- `src/services/MiniSockets.ts` has the full socket server implementation commented out. `src/services/MantleManager.ts` still imports it and calls `start`, `onTextMessage`, and `stop`. I added a no-op export surface so the app compiles without re-enabling the commented implementation. Local miniapp browser socket behavior may be disabled.

## OTA progress shape

- `src/components/glasses/OtaProgressSection.tsx` was importing a missing parser module and expects a legacy nested progress shape with `download` and `installation` sections. The active Bluetooth SDK type appears to expose a flatter `OtaProgress` shape. I kept the legacy nested checks by casting from `unknown`, so this section may not render real OTA progress correctly.

## Missing modules

- `src/utils/LogoutUtils.ts` was imported but missing. I re-exported `LogoutUtils` from `AuthContext`; verify that this is the intended public import path.

## Icons and theme tokens

- Several call sites use icon names that are not in the current `Icon` registry, including names such as `copy`, `share-2`, `grip-vertical`, `menu-2`, `warning`, `check-circle`, `spinner`, `refresh`, `download-circle-outline`, `video`, `checkbox-blank-circle-outline`, `sparkles`, `alert-circle`, `image-outline`, `headphones`, and `download`. I widened the icon prop type to keep current rendering behavior instead of adding icons.
- Some call sites pass the legacy `icon` prop to components that render `Icon` by `name`. I typed the prop but did not route it, so current rendering behavior is unchanged.
- `src/components/ignite/Toggle/Switch.tsx` references `iconRegistry.hidden` and `iconRegistry.view`, which are not registered. The cast preserves the current `undefined` image source behavior.
- `colors.transparent` and `colors.buttonPressed` are read from places where those top-level theme keys are not defined. I used narrow casts to keep the current `undefined` values instead of adding new theme tokens.

## Native module type gaps

- `src/components/glasses/NexDeveloperSettings.tsx` used to call `CoreModule.displayImage(...)` and `CoreModule.setLc3AudioEnabled(...)`, but those methods are not exported by the current Android/iOS Bluetooth SDK module. I restored the previous TODO no-op behavior from the old bridge path instead of typing nonexistent native methods.
- `src/components/glasses/NexDeveloperSettings.tsx` also references `settings:screenSettings`, which is not present in the typed translation keys.

## Ignored style props

- `ToggleSetting` and `SliderSetting` receive `containerStyle` from call sites, but the components did not use it. I typed the prop and kept it ignored to preserve current behavior. If those call sites expected styling to apply, the UI may be wrong today.
