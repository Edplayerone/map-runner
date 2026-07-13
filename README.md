# 🏃 Map Runner

A mobile web app for runners: **draw a route on the map, then get spoken
turn-by-turn directions in your headphones while you run** — like Google Maps
navigation, but built for running (including trails). It also records the path
you actually ran, with live distance, time, and pace.

No accounts, no API keys, no app store. It runs on free OpenStreetMap data,
which covers running/hiking trails far better than Google's walking directions.

## Features

- **Draw a route** — tap the map to drop points; the route snaps to runnable
  roads, footpaths, and trails (Valhalla pedestrian routing on OpenStreetMap).
- **Random loop generator** — enter a distance (e.g. 3 miles) and get a loop
  from your current location.
- **Voice turn-by-turn** — "In 400 feet, turn left onto Market Street," spoken
  with your phone's built-in text-to-speech. Works with AirPods/any headphones.
- **Off-route warning** — tells you if you drift off the planned path.
- **Mile splits** — announces each mile with total time and average pace.
- **Run recording** — your actual GPS trail is drawn on the map; distance,
  time, and pace shown live and summarized when you finish.
- **Installable PWA** — add it to your home screen and it opens full-screen.

## How to use it on a run

1. Open the app on your phone (see hosting below) and allow location access.
2. Tap **📍 My location**, then tap the map to draw your route — or tap
   **🔀 Loop…** for a random N-mile loop.
3. Put in your headphones, tap **🔈 Test voice** to confirm audio, then
   **▶ Start Run**.
4. Pocket your phone **with the screen on** — the app holds a screen wake lock
   and speaks every turn, mile split, and your arrival.

> **Why keep the screen on?** Phone browsers suspend GPS and JavaScript when
> the screen fully locks — that's a platform limit, not a bug. The app keeps
> the screen awake for you (dim your brightness to save battery). True
> locked-screen background navigation would require a native iOS/Android app —
> a natural next phase for this project.

## Hosting / running it

The app is static files — any HTTPS host works (**HTTPS is required** for GPS,
voice, and wake lock).

**GitHub Pages (recommended, free):** this repo includes a deploy workflow.
After merging to `main`, go to the repo's **Settings → Pages** and set
**Source: GitHub Actions**. Your app will be live at
`https://<your-username>.github.io/map-runner/`. Open that URL on your phone
and (optionally) **Add to Home Screen**.

**Local testing:** `npx serve .` and open `http://localhost:3000` (localhost
counts as secure, so GPS works).

## How it works

| Piece | Choice | Why |
|---|---|---|
| Map | [Leaflet](https://leafletjs.com) + OpenStreetMap tiles | Free, no API key |
| Routing | [Valhalla](https://valhalla.github.io/valhalla/) public server (`valhalla1.openstreetmap.de`), pedestrian costing | Free, no key, real spoken-style turn instructions, great trail coverage |
| Voice | Web Speech API (`speechSynthesis`) | The phone's built-in TTS voice — free, offline-capable |
| GPS | `geolocation.watchPosition` | Continuous tracking at ~1 Hz |
| Screen | Screen Wake Lock API | Keeps GPS alive during the run |

Turn guidance: the app map-matches your GPS position onto the planned route
(forward-window projection so loops don't snap to the wrong leg), computes the
distance along the route to the next maneuver, and speaks an early alert
(~400 ft out) plus the final instruction at the turn.

## Roadmap

- [x] Phase 1 (MVP): draw route → voice turn-by-turn → record run
- [x] Phase 2 (first cut): random N-mile loop generator
- [ ] Save/reload favorite routes; run history screen
- [ ] Smarter loop generation (prefer trails/parks, elevation-aware)
- [ ] Native app wrapper for true locked-screen background navigation
