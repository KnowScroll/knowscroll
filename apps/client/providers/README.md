# App-wide providers

The root layout mounts display and device choices, then the account scope. Start with
[account-scope.tsx](account-scope.tsx): it constructs the manager, starts it in an effect, observes
its state and disposes it on cleanup. The signed-in subtree is keyed by the actual scope so
an account or epoch change cannot retain another scope's cached state or controllers.

[device-preferences.tsx](device-preferences.tsx) sits above that scope. It applies motion, text,
Appearance (Light or Dark, #666) and playback choices immediately and keeps them on the device.
`PreferredAppearance` names the web page's appearance (`platform/appearance-page`) and gives Talk
its theme; a value stored before Appearance carries its Talk choice over (Paper → Light, dark sky →
Dark) and is rewritten once without `talkTheme`. System reduced motion
cannot be overridden toward more motion. A preference is not permission to record personal data.

The recording provider integration uses foreground/focus events to invalidate policy and obtain
a fresh read before collection resumes. It does not infer current policy from an old command ACK.
For example, coming back online can refresh authority; it must not automatically resend an unknown
opposite recording choice.

Run `pnpm --filter @knowscroll/client exec jest --ci --runInBand providers` from the repository
root. The fixtures check remount, account/epoch fencing and subscriptions; hosted release/privacy
journeys separately exercise the API and worker. These providers authorize no server operation.
