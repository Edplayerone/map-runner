/* RunEngine: a module-level singleton holding the active run. Location fixes
   arrive here from the background location task (which runs whether the app
   is foregrounded, backgrounded, or the screen is locked) and drive the
   spoken guidance and run recording. The UI subscribes for re-renders. */

import { LatLng, Route, METERS_PER_MILE, haversine } from './routing';
import { speak } from './speech';

const ALERT_DIST_M = 130; // "In 400 feet, turn left…"
const NOW_DIST_M = 25; // "Turn left onto…"
const OFF_ROUTE_DIST_M = 60;
const OFF_ROUTE_GRACE_MS = 12000;
const OFF_ROUTE_REMIND_MS = 60000;
const MIN_ACCURACY_M = 40;

export type Mode = 'plan' | 'running' | 'paused' | 'done';

export interface TrailPoint extends LatLng {
  t: number; // epoch ms
}

export interface RunState {
  mode: Mode;
  route: Route | null;
  trail: TrailPoint[];
  traveled: number; // meters
  activeMs: number;
  lastResumeAt: number;
  here: LatLng | null;
  nextManeuverIdx: number;
  distToTurn: number | null;
  offRoute: boolean;
  arrived: boolean;
}

interface Internal {
  routeSegIdx: number;
  lastFix: LatLng | null;
  alerted: Set<number>;
  announcedNow: Set<number>;
  milesAnnounced: number;
  offRouteSince: number | null;
  lastOffRouteSpokenAt: number;
}

const toRad = (d: number) => (d * Math.PI) / 180;

let state: RunState = emptyState();
let internal: Internal = emptyInternal();
const listeners = new Set<() => void>();

function emptyState(): RunState {
  return {
    mode: 'plan',
    route: null,
    trail: [],
    traveled: 0,
    activeMs: 0,
    lastResumeAt: 0,
    here: null,
    nextManeuverIdx: 1,
    distToTurn: null,
    offRoute: false,
    arrived: false,
  };
}

function emptyInternal(): Internal {
  return {
    routeSegIdx: 0,
    lastFix: null,
    alerted: new Set(),
    announcedNow: new Set(),
    milesAnnounced: 0,
    offRouteSince: null,
    lastOffRouteSpokenAt: 0,
  };
}

function notify(): void {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): RunState {
  return state;
}

export function elapsedSec(): number {
  let ms = state.activeMs;
  if (state.mode === 'running') ms += Date.now() - state.lastResumeAt;
  return ms / 1000;
}

export function spokenTime(sec: number): string {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let out = '';
  if (h) out += `${h} hour${h > 1 ? 's' : ''} `;
  if (m) out += `${m} minute${m > 1 ? 's' : ''} `;
  if (s || !out) out += `${s} seconds`;
  return out.trim();
}

function spokenFeet(meters: number): string {
  const feet = meters * 3.28084;
  if (feet > 900) {
    const tenth = Math.round((meters / METERS_PER_MILE) * 10) / 10;
    return tenth <= 0.3 ? 'a quarter mile' : `${tenth} miles`;
  }
  return `${Math.max(50, Math.round(feet / 50) * 50)} feet`;
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function startRun(route: Route): void {
  state = {
    ...emptyState(),
    mode: 'running',
    route,
    lastResumeAt: Date.now(),
  };
  internal = emptyInternal();
  const first = route.maneuvers[0];
  speak(
    `Starting run. ${(route.totalMeters / METERS_PER_MILE).toFixed(1)} miles to go. ${
      first ? first.instruction : ''
    }`,
    true,
  );
  notify();
}

export function pauseResume(): void {
  if (state.mode === 'running') {
    state = { ...state, mode: 'paused', activeMs: state.activeMs + (Date.now() - state.lastResumeAt) };
    speak('Run paused.', true);
  } else if (state.mode === 'paused') {
    state = { ...state, mode: 'running', lastResumeAt: Date.now() };
    speak('Resuming run.', true);
  }
  notify();
}

export function finishRun(): { miles: number; seconds: number } {
  if (state.mode === 'running') {
    state = { ...state, activeMs: state.activeMs + (Date.now() - state.lastResumeAt) };
  }
  state = { ...state, mode: 'done' };
  const miles = state.traveled / METERS_PER_MILE;
  const seconds = state.activeMs / 1000;
  const pace = miles > 0.02 ? seconds / miles : NaN;
  speak(
    `Run finished. ${miles.toFixed(2)} miles in ${spokenTime(seconds)}.` +
      (isFinite(pace) ? ` Average pace ${spokenTime(pace)} per mile.` : ''),
    true,
  );
  notify();
  return { miles, seconds };
}

export function reset(): void {
  state = emptyState();
  internal = emptyInternal();
  notify();
}

export function onLocation(lat: number, lng: number, accuracy: number | null): void {
  const here = { lat, lng };
  state = { ...state, here };
  if (state.mode !== 'running' || !state.route) {
    notify();
    return;
  }
  if (accuracy != null && accuracy > MIN_ACCURACY_M) {
    notify();
    return;
  }

  if (internal.lastFix) {
    const d = haversine(internal.lastFix, here);
    if (d < 2) {
      notify();
      return; // GPS jitter while standing still
    }
    if (d < 200) state = { ...state, traveled: state.traveled + d };
  }
  internal.lastFix = here;
  state = { ...state, trail: [...state.trail, { ...here, t: Date.now() }] };

  announceMileSplits();
  guide(here);
  notify();
}

function announceMileSplits(): void {
  const miles = Math.floor(state.traveled / METERS_PER_MILE);
  if (miles > internal.milesAnnounced) {
    internal.milesAnnounced = miles;
    const pace = elapsedSec() / (state.traveled / METERS_PER_MILE);
    speak(
      `Mile ${miles}. Time ${spokenTime(elapsedSec())}. Average pace ${spokenTime(pace)} per mile.`,
    );
  }
}

function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): { t: number; dist: number } {
  // fast planar projection (fine at street scale), distance via haversine
  const cosLat = Math.cos(toRad(p.lat));
  const dx = (b.lng - a.lng) * cosLat;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((p.lng - a.lng) * cosLat * dx + (p.lat - a.lat) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { t, dist: haversine(p, proj) };
}

/* Match the runner onto the route (forward-window search so loops that pass
   near the start don't snap to the wrong leg), then fire turn announcements. */
function guide(here: LatLng): void {
  if (state.arrived || !state.route) return;
  const { shape, cumDist, maneuvers, totalMeters } = state.route;

  let best = { off: Infinity, along: 0, seg: internal.routeSegIdx };
  const from = Math.max(0, internal.routeSegIdx - 5);
  const to = Math.min(shape.length - 2, internal.routeSegIdx + 300);
  for (let i = from; i <= to; i++) {
    const p = projectOnSegment(here, shape[i], shape[i + 1]);
    if (p.dist < best.off) {
      best = { off: p.dist, along: cumDist[i] + p.t * (cumDist[i + 1] - cumDist[i]), seg: i };
    }
  }
  internal.routeSegIdx = best.seg;

  // off-route handling
  if (best.off > OFF_ROUTE_DIST_M) {
    if (!internal.offRouteSince) internal.offRouteSince = Date.now();
    if (
      Date.now() - internal.offRouteSince > OFF_ROUTE_GRACE_MS &&
      Date.now() - internal.lastOffRouteSpokenAt > OFF_ROUTE_REMIND_MS
    ) {
      internal.lastOffRouteSpokenAt = Date.now();
      speak('You are off the route. Head back toward the green line.');
    }
    state = { ...state, offRoute: true, distToTurn: null };
    return;
  }
  internal.offRouteSince = null;

  // arrival
  if (totalMeters - best.along < 30 && state.traveled > 100) {
    state = { ...state, arrived: true, offRoute: false, distToTurn: null };
    speak('You have arrived. Route complete. Great run!', true);
    return;
  }

  // advance past maneuvers already crossed
  let next = state.nextManeuverIdx;
  while (next < maneuvers.length && maneuvers[next].distAlong < best.along - 15) next++;
  const m = maneuvers[next];
  if (!m) {
    state = { ...state, nextManeuverIdx: next, offRoute: false, distToTurn: null };
    return;
  }
  const distToTurn = m.distAlong - best.along;

  // Park/plaza path networks produce clusters of unnamed micro-turns; speak
  // only the first of a cluster so the voice stays calm (banner still shows).
  const prev = maneuvers[next - 1];
  const quiet =
    /the walkway|the crosswalk|the path/i.test(m.instruction) &&
    prev != null &&
    m.distAlong - prev.distAlong < 60;

  if (distToTurn <= NOW_DIST_M && !internal.announcedNow.has(next)) {
    internal.announcedNow.add(next);
    if (!quiet) speak(m.instruction, true);
  } else if (distToTurn <= ALERT_DIST_M && !internal.alerted.has(next)) {
    internal.alerted.add(next);
    if (!quiet) speak(`In ${spokenFeet(distToTurn)}, ${lowerFirst(m.alert)}`);
  }
  state = { ...state, nextManeuverIdx: next, offRoute: false, distToTurn };
}
