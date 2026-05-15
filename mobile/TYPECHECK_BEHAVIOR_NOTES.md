# Type Check Behavior Notes

These are TypeScript errors that still point at possible runtime or product issues outside this type-checking pass.

## Native module exports

- `src/components/glasses/NexDeveloperSettings.tsx` references display-image and LC3-audio developer controls, but the current Android/iOS Expo module does not export `displayImage(...)` or `setLc3AudioEnabled(...)`. Android and iOS have lower-level display-image SGC helpers, but there is no JS-facing Bluetooth SDK method for this page to call. The page now avoids typing nonexistent native methods and preserves the existing logged TODO behavior.

## Icon props

- Some call sites pass an `icon` prop to `Icon` / `PressableIcon`, but the legacy implementation renders from `name`. Confirmed affected call sites include `Header`, `ListItem`, `SelectSetting`, and `SelectWithSearchSetting`. This PR keeps `icon` typed but ignored to avoid changing visible UI; fix separately by migrating those call sites to `name` and choosing the exact icon names to render.
