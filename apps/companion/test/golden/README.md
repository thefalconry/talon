# Golden renders

Visual review renders of the conversation view and settings, across the
scenarios that matter for chat UX (a burst of mid-turn messages with a tool
still running, a streaming reply, markdown, long code, errors, attachments,
an ordinary back-and-forth, the empty state) on a 390×844 phone and a
1100×760 desktop window.

```sh
TALON_GOLDENS=1 flutter test test/golden --update-goldens
open test/golden/goldens/
```

They are **not** a CI gate: text rasterisation differs between macOS and the
Linux runners, so the PNGs are gitignored and regenerated locally whenever a
chat or settings change needs eyes on it. Without `TALON_GOLDENS=1` the files
register one skipped placeholder test each, so `flutter test` stays green.

- `golden_harness.dart` — fonts, viewports, a fake image server (every
  `NetworkImage` gets the app icon), seeded `AppState`, `shoot()`.
- `chat_fixtures.dart` — the chat scenarios; add one there and it is picked
  up for both viewports.
