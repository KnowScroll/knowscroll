# Expo build plugins

[app.json](../app.json) registers these CommonJS plugins. Expo calls them while generating the
native project; no TypeScript import from a screen is required. Preserve the `require` exports
and registration when looking for unused code.

| Plugin | Why the native build needs it |
| --- | --- |
| `font-scale-config-changes.js` | Adds font-scale and density handling to MainActivity so a settings change does not recreate the activity and lose the navigation tree. |
| `test-api-cleartext.js` | Allows emulator HTTP only for an explicitly marked fixture build; ordinary builds retain Android's HTTPS policy. |
| `keep-expo-gl-views.js` | Keeps the expo-gl classes R8 would otherwise rename; Expo finds their constructors by reflection. Repeated prebuilds use a marker to avoid duplicate rules. |

The [native workflow](../../../.github/workflows/native.yml) generates and checks the Android
manifest and embedded bundle on hosted runners, then drives an emulator with authored fixtures.
These source hooks do not prove a build was run or an app link works on a physical device.
Keep generated `android/` and `ios/` output out of the repository. A plugin change needs the
corresponding hosted build; ordinary TypeScript tests cannot prove reflection or manifest behavior.
