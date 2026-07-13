# Map Runner — native app (iPhone & Android)

The native version of Map Runner. Same features as the web app (draw a route,
random loop generator, voice turn-by-turn, mile splits, off-route warnings,
run recording) **plus true background operation**: directions keep speaking
with the screen locked or another app in the foreground, and the voice ducks
your music instead of stopping it — the full Google-Maps-navigation behavior.

Built with Expo / React Native:

| Piece | Choice |
|---|---|
| Map | MapLibre React Native + OpenStreetMap raster tiles (no API keys) |
| Routing | Valhalla public server, pedestrian costing (no API keys) |
| Background GPS | `expo-location` background updates + `expo-task-manager` |
| Voice | `expo-speech` (system TTS) with an `expo-audio` session set to play in background and duck other audio |

## Building and installing on your phone

The app must be compiled into an installable binary. The easiest path is
**EAS Build** (Expo's free cloud build service — no Mac or Android Studio
needed for Android):

```bash
cd native
npm install
npx eas-cli login          # create a free account at expo.dev if you don't have one
```

### Android (easiest — free)

```bash
npx eas-cli build --platform android --profile preview
```

When the build finishes (~10–20 min), EAS prints a link/QR code. Open it on
your Android phone, download the APK, and install it (allow "install from
unknown sources" if prompted). Done.

### iPhone

Apple requires code signing, so pick one:

- **Apple Developer Program ($99/yr, no Mac needed):**
  `npx eas-cli build --platform ios --profile preview` — EAS walks you through
  signing and registering your iPhone, then gives you an install link. For a
  permanent install, use the `production` profile and `npx eas-cli submit` to
  TestFlight.
- **Free Apple ID (Mac with Xcode required):**
  `npx expo run:ios --device` with your iPhone plugged in. Free-account
  installs expire after 7 days and need re-running.

## First run

1. Open the app and allow location.
2. When you tap **▶ Start Run** the app asks to upgrade location access to
   **"Always"** (iOS) / **"Allow all the time"** (Android) — this is what lets
   directions keep speaking with the screen locked. Grant it.
3. On Android, a persistent notification ("Map Runner is guiding your run")
   appears during runs — that's the foreground service keeping GPS alive; it
   disappears when you finish.

## Development

```bash
npm start            # Metro dev server
npx tsc --noEmit     # typecheck
```

Note: background location and MapLibre are native modules, so the app does
**not** run in Expo Go — use a development build
(`npx eas-cli build --profile development`) or the preview build above.
