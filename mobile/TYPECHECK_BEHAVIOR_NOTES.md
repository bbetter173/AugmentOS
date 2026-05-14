# Type Check Behavior Notes

These are TypeScript errors that still point at possible runtime or product issues outside this type-checking pass.

## Native module exports

- `src/components/glasses/NexDeveloperSettings.tsx` references display-image and LC3-audio developer controls, but the current Android/iOS Expo module does not export `displayImage(...)` or `setLc3AudioEnabled(...)`. The page now avoids typing nonexistent native methods and preserves the existing logged TODO behavior.

## Missing modules

- `src/utils/LogoutUtils.ts` was imported but missing. The PR re-exports `LogoutUtils` from `AuthContext`; verify whether that should remain the public import path or whether `LogoutUtils` should move into its own utility module later.
