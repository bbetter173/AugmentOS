# Type Check Behavior Notes

These are TypeScript errors that still point at possible runtime or product issues outside this type-checking pass.

## Icon props

- Some call sites pass an `icon` prop to `Icon` / `PressableIcon`, but the legacy implementation renders from `name`. Confirmed affected call sites include `Header`, `ListItem`, `SelectSetting`, and `SelectWithSearchSetting`. This PR keeps `icon` typed but ignored to avoid changing visible UI; fix separately by migrating those call sites to `name` and choosing the exact icon names to render.
