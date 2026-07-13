/* Valhalla pedestrian routing on OpenStreetMap — same logic as the web app. */

export const METERS_PER_MILE = 1609.344;
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Maneuver {
  instruction: string;
  alert: string;
  type: number;
  shapeIndex: number;
  distAlong: number; // meters from route start
}

export interface Route {
  shape: LatLng[];
  cumDist: number[]; // cumulative meters per shape point
  maneuvers: Maneuver[];
  totalMeters: number;
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function destPoint(origin: LatLng, bearingDeg: number, distM: number): LatLng {
  const R = 6371000;
  const br = toRad(bearingDeg);
  const d = distM / R;
  const la1 = toRad(origin.lat);
  const lo1 = toRad(origin.lng);
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return { lat: toDeg(la2), lng: toDeg(lo2) };
}

export function decodePolyline6(str: string): LatLng[] {
  const pts: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    pts.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return pts;
}

interface ValhallaManeuver {
  instruction: string;
  verbal_transition_alert_instruction?: string;
  type: number;
  begin_shape_index: number;
}

interface ValhallaTrip {
  legs: { shape: string; maneuvers: ValhallaManeuver[] }[];
}

function buildRoute(trip: ValhallaTrip): Route {
  const shape: LatLng[] = [];
  const maneuvers: Maneuver[] = [];
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
        distAlong: 0,
      });
    }
  }
  const cumDist = [0];
  for (let i = 1; i < shape.length; i++) {
    cumDist.push(cumDist[i - 1] + haversine(shape[i - 1], shape[i]));
  }
  const totalMeters = cumDist[cumDist.length - 1];
  for (const m of maneuvers) {
    m.distAlong = cumDist[Math.min(m.shapeIndex, cumDist.length - 1)];
  }
  return { shape, cumDist, maneuvers, totalMeters };
}

export async function fetchRoute(waypoints: LatLng[]): Promise<Route> {
  const locations = waypoints.map((w, i) => ({
    lat: w.lat,
    lon: w.lng,
    type: i === 0 || i === waypoints.length - 1 ? 'break' : 'through',
  }));
  const res = await fetch(VALHALLA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations,
      costing: 'pedestrian',
      directions_options: { units: 'miles', language: 'en-US' },
    }),
  });
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);
  const data = await res.json();
  return buildRoute(data.trip);
}

/* Random loop: 3 points on a rough circle, routed back to the start.
   One correction pass rescales the circle toward the requested distance. */
export async function generateLoop(
  origin: LatLng,
  miles: number,
): Promise<{ route: Route; waypoints: LatLng[] }> {
  let radius = (miles * METERS_PER_MILE) / 6.5;
  const heading = Math.floor(Math.random() * 360);
  let route: Route | null = null;
  let waypoints: LatLng[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    waypoints = [
      origin,
      destPoint(origin, heading, radius),
      destPoint(origin, heading + 90, radius * 1.4),
      destPoint(origin, heading + 180, radius),
      origin,
    ];
    route = await fetchRoute(waypoints);
    const actualMiles = route.totalMeters / METERS_PER_MILE;
    if (Math.abs(actualMiles - miles) / miles < 0.15) break;
    radius *= miles / actualMiles;
  }
  if (!route) throw new Error('Could not build a loop here.');
  return { route, waypoints };
}
