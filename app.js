/* Map Runner — draw a route, run it with spoken turn-by-turn directions. */
'use strict';

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const METERS_PER_MILE = 1609.344;
const ALERT_DIST_M = 130;      // "In 400 feet, turn left…"
const NOW_DIST_M = 25;         // "Turn left onto…"
const OFF_ROUTE_DIST_M = 60;
const OFF_ROUTE_REMIND_MS = 60000;
const MIN_ACCURACY_M = 40;     // ignore GPS fixes worse than this

// ---------- state ----------
let map, tileLayer;
let waypoints = [];            // [{lat,lng,marker}]
let route = null;              // {shape:[[lat,lng]], cumDist:[m], maneuvers:[…], totalMeters}
let routeLine = null;
let trailLine = null;
let meMarker = null;

let mode = 'plan';             // plan | running | paused | done
let watchId = null;
let wakeLock = null;
let muted = false;

let run = null;                // per-run state, see startRun()

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function destPoint(lat, lng, bearingDeg, distM) {
  const R = 6371000, br = toRad(bearingDeg), d = distM / R;
  const la1 = toRad(lat), lo1 = toRad(lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lng: toDeg(lo2) };
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPace(secPerMile) {
  if (!isFinite(secPerMile) || secPerMile <= 0 || secPerMile > 3600) return '–:––';
  const m = Math.floor(secPerMile / 60), s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function spokenTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  let out = '';
  if (h) out += `${h} hour${h > 1 ? 's' : ''} `;
  if (m) out += `${m} minute${m > 1 ? 's' : ''} `;
  if (s || !out) out += `${s} seconds`;
  return out.trim();
}

function spokenFeet(meters) {
  const feet = meters * 3.28084;
  if (feet > 900) {
    const tenth = Math.round(meters / METERS_PER_MILE * 10) / 10;
    return tenth <= 0.3 ? 'a quarter mile' : `${tenth} miles`;
  }
  return `${Math.max(50, Math.round(feet / 50) * 50)} feet`;
}

function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------- speech ----------
function speak(text, interrupt = false) {
  if (muted || !('speechSynthesis' in window) || !text) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

// iOS unlocks speech synthesis only from a user gesture.
function warmUpSpeech() {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ---------- polyline6 decoding ----------
function decodePolyline6(str) {
  const pts = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    pts.push([lat / 1e6, lng / 1e6]);
  }
  return pts;
}

// ---------- routing ----------
async function fetchRoute() {
  if (waypoints.length < 2) { setRoute(null); return; }
  const locations = waypoints.map((w, i) => ({
    lat: w.lat, lon: w.lng,
    type: (i === 0 || i === waypoints.length - 1) ? 'break' : 'through',
  }));
  const body = {
    locations,
    costing: 'pedestrian',
    directions_options: { units: 'miles', language: 'en-US' },
  };
  toast('Routing…', 1500);
  try {
    const res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Routing failed (${res.status})`);
    const data = await res.json();
    setRoute(buildRoute(data.trip));
  } catch (err) {
    console.error(err);
    toast('Could not find a runnable route between those points.');
  }
}

function buildRoute(trip) {
  const shape = [];
  const maneuvers = [];
  for (const leg of trip.legs) {
    const legShape = decodePolyline6(leg.shape);
    const offset = shape.length ? shape.length - 1 : 0;
    // legs share their boundary point; drop the duplicate
    shape.push(...(shape.length ? legShape.slice(1) : legShape));
    for (const m of leg.maneuvers) {
      maneuvers.push({
        instruction: m.instruction,
        alert: m.verbal_transition_alert_instruction || m.instruction,
        type: m.type,
        shapeIndex: m.begin_shape_index + offset,
      });
    }
  }
  // cumulative distance along the shape, in meters
  const cumDist = [0];
  for (let i = 1; i < shape.length; i++) {
    const d = haversine({ lat: shape[i - 1][0], lng: shape[i - 1][1] },
                        { lat: shape[i][0], lng: shape[i][1] });
    cumDist.push(cumDist[i - 1] + d);
  }
  const totalMeters = cumDist[cumDist.length - 1];
  for (const m of maneuvers) m.distAlong = cumDist[Math.min(m.shapeIndex, cumDist.length - 1)];
  return { shape, cumDist, maneuvers, totalMeters };
}

function setRoute(r) {
  route = r;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (r) {
    routeLine = L.polyline(r.shape, { color: '#10b981', weight: 5, opacity: 0.9 }).addTo(map);
    const turns = r.maneuvers.filter((m) => ![1, 2, 3, 4, 5, 6].includes(m.type)).length;
    $('route-miles').textContent = `${(r.totalMeters / METERS_PER_MILE).toFixed(2)} mi`;
    $('route-turns').textContent = `${turns} turn${turns === 1 ? '' : 's'}`;
    $('route-summary').classList.remove('hidden');
  } else {
    $('route-summary').classList.add('hidden');
  }
  $('btn-start').disabled = !r;
}

// ---------- planning ----------
function addWaypoint(latlng) {
  const marker = L.marker(latlng, {
    icon: L.divIcon({ className: 'wp-marker' }),
  }).addTo(map);
  waypoints.push({ lat: latlng.lat, lng: latlng.lng, marker });
  fetchRoute();
}

function undoWaypoint() {
  const w = waypoints.pop();
  if (w) map.removeLayer(w.marker);
  fetchRoute();
}

function clearPlan() {
  for (const w of waypoints) map.removeLayer(w.marker);
  waypoints = [];
  setRoute(null);
  if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
}

// Random loop: place 3 points on a rough circle and route through them back to start.
async function generateLoop(miles) {
  const start = await getCurrentPosition().catch(() => null);
  const origin = start
    ? { lat: start.coords.latitude, lng: start.coords.longitude }
    : map.getCenter();
  clearPlan();

  let radius = (miles * METERS_PER_MILE) / 6.5;  // streets wiggle; tuned below
  const heading = Math.floor(Math.random() * 360);

  for (let attempt = 0; attempt < 2; attempt++) {
    const pts = [origin,
      destPoint(origin.lat, origin.lng, heading, radius),
      destPoint(origin.lat, origin.lng, heading + 90, radius * 1.4),
      destPoint(origin.lat, origin.lng, heading + 180, radius),
      origin];
    for (const w of waypoints) map.removeLayer(w.marker);
    waypoints = pts.map((p) => ({
      lat: p.lat, lng: p.lng,
      marker: L.marker(p, { icon: L.divIcon({ className: 'wp-marker' }) }).addTo(map),
    }));
    await fetchRoute();
    if (!route) { toast('Could not build a loop here — try drawing one instead.'); return; }
    const actualMiles = route.totalMeters / METERS_PER_MILE;
    if (Math.abs(actualMiles - miles) / miles < 0.15) break;
    radius *= miles / actualMiles;  // one correction pass
  }
  if (route) {
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    toast(`Loop ready: ${(route.totalMeters / METERS_PER_MILE).toFixed(1)} miles`);
  }
}

// ---------- geolocation ----------
function getCurrentPosition(opts = { enableHighAccuracy: true, timeout: 12000 }) {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, opts));
}

async function locateMe() {
  try {
    const pos = await getCurrentPosition();
    const ll = [pos.coords.latitude, pos.coords.longitude];
    map.setView(ll, 16);
    updateMeMarker({ lat: ll[0], lng: ll[1] });
  } catch (err) {
    toast('Location unavailable — allow location access and use HTTPS.');
  }
}

function updateMeMarker(latlng) {
  if (!meMarker) {
    meMarker = L.marker(latlng, { icon: L.divIcon({ className: 'me-marker' }), zIndexOffset: 1000 }).addTo(map);
  } else {
    meMarker.setLatLng(latlng);
  }
}

// ---------- wake lock ----------
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* not fatal */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (mode === 'running' || mode === 'paused') && !wakeLock) {
    acquireWakeLock();
  }
});

// ---------- running ----------
function startRun() {
  if (!route) return;
  warmUpSpeech();
  run = {
    startedAt: Date.now(),
    activeMs: 0,          // accumulated while not paused
    lastResumeAt: Date.now(),
    trail: [],
    traveled: 0,          // meters, from raw GPS trail
    lastFix: null,
    routeSegIdx: 0,       // last matched segment on the route shape
    nextManeuver: 1,      // maneuvers[0] is the "start" instruction
    alerted: new Set(),
    announcedNow: new Set(),
    milesAnnounced: 0,
    offRouteSince: null,
    lastOffRouteSpokenAt: 0,
    arrived: false,
  };
  mode = 'running';
  showPanel('run');
  $('stats').classList.remove('hidden');
  $('turn-card').classList.remove('hidden');
  trailLine = L.polyline([], { color: '#3b82f6', weight: 4, opacity: 0.9 }).addTo(map);

  acquireWakeLock();
  watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
  });
  setInterval(tickStats, 1000);

  const first = route.maneuvers[0];
  speak(`Starting run. ${(route.totalMeters / METERS_PER_MILE).toFixed(1)} miles to go. ${first ? first.instruction : ''}`, true);
  updateTurnCard();
}

function onFixError(err) {
  console.warn('geolocation error', err);
  toast('GPS signal lost — make sure location access is allowed.');
}

function elapsedSec() {
  if (!run) return 0;
  let ms = run.activeMs;
  if (mode === 'running') ms += Date.now() - run.lastResumeAt;
  return ms / 1000;
}

function tickStats() {
  if (!run || mode === 'done') return;
  $('stat-time').textContent = fmtTime(elapsedSec());
  const miles = run.traveled / METERS_PER_MILE;
  $('stat-dist').textContent = miles.toFixed(2);
  $('stat-pace').textContent = fmtPace(miles > 0.02 ? elapsedSec() / miles : NaN);
}

function onFix(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const here = { lat: latitude, lng: longitude };
  updateMeMarker(here);
  if (mode !== 'running') return;
  if (accuracy > MIN_ACCURACY_M) return;

  if (run.lastFix) {
    const d = haversine(run.lastFix, here);
    if (d < 2) return;               // GPS jitter while standing still
    if (d < 200) run.traveled += d;  // ignore teleport glitches
  }
  run.lastFix = here;
  run.trail.push([latitude, longitude]);
  trailLine.addLatLng([latitude, longitude]);
  map.panTo(here, { animate: true });

  announceMileSplits();
  guide(here);
}

function announceMileSplits() {
  const miles = Math.floor(run.traveled / METERS_PER_MILE);
  if (miles > run.milesAnnounced) {
    run.milesAnnounced = miles;
    const pace = elapsedSec() / (run.traveled / METERS_PER_MILE);
    speak(`Mile ${miles}. Time ${spokenTime(elapsedSec())}. Average pace ${spokenTime(pace)} per mile.`);
  }
}

// Match the runner to the route (forward-window search so loops that pass
// near the start don't snap to the wrong leg), then fire turn announcements.
function guide(here) {
  if (run.arrived) return;
  const { shape, cumDist, maneuvers, totalMeters } = route;
  let best = { off: Infinity, along: 0, seg: run.routeSegIdx };
  const from = Math.max(0, run.routeSegIdx - 5);
  const to = Math.min(shape.length - 2, run.routeSegIdx + 300);
  for (let i = from; i <= to; i++) {
    const p = projectOnSegment(here, shape[i], shape[i + 1]);
    if (p.dist < best.off) {
      best = { off: p.dist, along: cumDist[i] + p.t * (cumDist[i + 1] - cumDist[i]), seg: i };
    }
  }
  run.routeSegIdx = best.seg;

  // off-route handling
  if (best.off > OFF_ROUTE_DIST_M) {
    if (!run.offRouteSince) run.offRouteSince = Date.now();
    if (Date.now() - run.offRouteSince > 12000 &&
        Date.now() - run.lastOffRouteSpokenAt > OFF_ROUTE_REMIND_MS) {
      run.lastOffRouteSpokenAt = Date.now();
      speak('You are off the route. Head back toward the green line.');
      $('turn-dist').textContent = '';
      $('turn-instruction').textContent = 'Off route — return to the green path';
      $('turn-icon').textContent = '⚠';
    }
    return;
  }
  run.offRouteSince = null;

  // arrival
  if (!run.arrived && totalMeters - best.along < 30 && run.traveled > 100) {
    run.arrived = true;
    speak('You have arrived. Route complete. Great run!', true);
    $('turn-dist').textContent = '';
    $('turn-instruction').textContent = '🏁 Route complete!';
    $('turn-icon').textContent = '🏁';
    return;
  }

  // advance past maneuvers we've already crossed
  while (run.nextManeuver < maneuvers.length &&
         maneuvers[run.nextManeuver].distAlong < best.along - 15) {
    run.nextManeuver++;
  }
  const m = maneuvers[run.nextManeuver];
  if (!m) return;
  const distToTurn = m.distAlong - best.along;

  if (distToTurn <= NOW_DIST_M && !run.announcedNow.has(run.nextManeuver)) {
    run.announcedNow.add(run.nextManeuver);
    speak(m.instruction, true);
  } else if (distToTurn <= ALERT_DIST_M && !run.alerted.has(run.nextManeuver)) {
    run.alerted.add(run.nextManeuver);
    speak(`In ${spokenFeet(distToTurn)}, ${lowerFirst(m.alert)}`);
  }
  updateTurnCard(distToTurn);
}

function projectOnSegment(p, a, b) {
  // fast planar projection (fine at street scale), distances via haversine
  const ax = a[1], ay = a[0], bx = b[1], by = b[0];
  const cosLat = Math.cos(toRad(p.lat));
  const dx = (bx - ax) * cosLat, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = (((p.lng - ax) * cosLat) * dx + (p.lat - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const proj = { lat: ay + (by - ay) * t, lng: ax + (bx - ax) * t };
  return { t, dist: haversine(p, proj) };
}

function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

const TURN_ICONS = {
  8: '↑', 9: '↗', 10: '→', 11: '↘', 12: '↩', 13: '↪', 14: '↙', 15: '←', 16: '↖',
  17: '↑', 18: '→', 19: '↑', 20: '←', 21: '↩', 22: '↑', 23: '↗', 24: '↖',
  26: '⟳', 27: '⟲', 4: '🏁', 5: '🏁', 6: '🏁',
};

function updateTurnCard(distToTurn) {
  const m = route.maneuvers[run.nextManeuver];
  if (!m || run.arrived) return;
  $('turn-icon').textContent = TURN_ICONS[m.type] || '•';
  $('turn-instruction').textContent = m.instruction;
  $('turn-dist').textContent = distToTurn != null
    ? `in ${Math.round(distToTurn * 3.28084 / 10) * 10} ft` : '';
}

function pauseRun() {
  if (mode === 'running') {
    mode = 'paused';
    run.activeMs += Date.now() - run.lastResumeAt;
    $('btn-pause').textContent = '▶ Resume';
    speak('Run paused.', true);
  } else if (mode === 'paused') {
    mode = 'running';
    run.lastResumeAt = Date.now();
    $('btn-pause').textContent = '⏸ Pause';
    speak('Resuming run.', true);
  }
}

function finishRun() {
  if (mode === 'running') run.activeMs += Date.now() - run.lastResumeAt;
  mode = 'done';
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('turn-card').classList.add('hidden');

  const miles = run.traveled / METERS_PER_MILE;
  const sec = run.activeMs / 1000;
  const pace = miles > 0.02 ? sec / miles : NaN;
  $('run-summary').innerHTML =
    `🏁 <b>${miles.toFixed(2)} mi</b> in <b>${fmtTime(sec)}</b>` +
    (isFinite(pace) ? ` · <b>${fmtPace(pace)}</b> /mi` : '');
  showPanel('done');
  speak(`Run finished. ${miles.toFixed(2)} miles in ${spokenTime(sec)}.` +
    (isFinite(pace) ? ` Average pace ${spokenTime(pace)} per mile.` : ''), true);

  saveRun({ date: new Date().toISOString(), miles, seconds: sec, trail: run.trail });
}

function saveRun(record) {
  try {
    const runs = JSON.parse(localStorage.getItem('mapRunnerRuns') || '[]');
    runs.push(record);
    localStorage.setItem('mapRunnerRuns', JSON.stringify(runs.slice(-50)));
  } catch (_) { /* storage full or unavailable */ }
}

function newRoute() {
  mode = 'plan';
  run = null;
  clearPlan();
  $('stats').classList.add('hidden');
  showPanel('plan');
}

// ---------- UI wiring ----------
function showPanel(name) {
  for (const p of document.querySelectorAll('.panel-page')) p.classList.add('hidden');
  $(`panel-${name}`).classList.remove('hidden');
}

function init() {
  map = L.map('map', { zoomControl: false }).setView([37.7749, -122.4194], 14);
  tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  map.on('click', (e) => { if (mode === 'plan') addWaypoint(e.latlng); });

  $('btn-locate').addEventListener('click', locateMe);
  $('btn-undo').addEventListener('click', undoWaypoint);
  $('btn-clear').addEventListener('click', clearPlan);
  $('btn-start').addEventListener('click', startRun);
  $('btn-test-voice').addEventListener('click', () =>
    speak('Voice check. Turn-by-turn directions will sound like this.', true));

  $('btn-loop').addEventListener('click', () => showPanel('loop'));
  $('btn-loop-cancel').addEventListener('click', () => showPanel('plan'));
  $('btn-loop-go').addEventListener('click', async () => {
    const miles = parseFloat($('loop-miles').value);
    if (!miles || miles <= 0) { toast('Enter a distance in miles.'); return; }
    showPanel('plan');
    await generateLoop(miles);
  });

  $('btn-pause').addEventListener('click', pauseRun);
  $('btn-finish').addEventListener('click', finishRun);
  $('btn-new').addEventListener('click', newRoute);
  $('btn-mute').addEventListener('click', () => {
    muted = !muted;
    if (muted) speechSynthesis.cancel();
    $('btn-mute').textContent = muted ? '🔇' : '🔊';
  });

  locateMe();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // read-only debug handle (used by the browser test harness)
  window.__mr = {
    get mode() { return mode; },
    get route() { return route; },
    get run() { return run; },
    get waypoints() { return waypoints.map((w) => ({ lat: w.lat, lng: w.lng })); },
  };
}

init();
